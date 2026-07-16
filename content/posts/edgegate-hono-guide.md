---
title: "Edge Computing, Hono, and Building an API Gateway on Cloudflare Workers"
date: "2026-7-15"
readTime: "35 min read"
category: "System Design"
---

## A Note Before We Start

This guide assumes you know what a backend framework is (routing, middleware, request handling) but nothing about edge computing, Cloudflare Workers, V8 isolates, or Hono. Every concept will be explained from the ground up. By the end, you'll have deployed a real API gateway to 300+ locations worldwide.

Let's start with the question that everything else depends on: what actually happens when you run code on the edge?

---

## Part 1: The Edge Model

### What "The Edge" Actually Is

When you deploy a traditional backend, you rent a server in one geographic region. All traffic — from users in New York, Tokyo, London, and Sydney — must travel to that one location. If your server is in `us-east-1`, a user in Tokyo experiences at least 100ms of round-trip latency just from the speed of light, before your application does any work.

The edge flips this model. Instead of one server in one region, there are thousands of servers distributed across the world — inside the networks of ISPs, at the edge of cloud providers, in every major city. When a user makes a request, it's handled by the server physically closest to them.

```
Traditional:
  User in Tokyo ──────────────────────────────► Server in us-east-1
  Round trip: ~150ms before any code runs

Edge:
  User in Tokyo ──► Edge node in Tokyo ──► Origin in us-east-1 (if needed)
  Round trip to edge: ~1ms
  Code runs in Tokyo. Only cache misses go to origin.
```

This is not a theoretical architecture. Cloudflare has 330+ data centers in 120+ countries. AWS has 100+ edge locations through CloudFront. Fastly has 60+. Akamai has 4,000+. When you deploy to Cloudflare Workers, your code is deployed to every one of their 330+ locations simultaneously.

### What "No Server" Actually Means (The Most Important Section)

When people say edge computing has "no server," they don't mean the code runs on nothing. They mean there is **no long-running process that you manage**.

Here's what a traditional Node.js server does, step by step:

```
1. You write: app.listen(3000)
2. Node.js starts a process on your machine (or a VM in the cloud)
3. That process binds to a port (3000) and starts listening for TCP connections
4. The process stays alive indefinitely, waiting for HTTP requests
5. When a request arrives, the same process handles it
6. Variables in memory persist between requests — you can cache data in a global variable
7. If the process crashes, all in-flight requests are lost
8. If traffic increases, you manually or automatically start more processes
```

The process is a long-lived entity. It has state. It has a lifecycle. **You pay for it whether it's handling requests or sitting idle.**

Now here's what happens on Cloudflare Workers:

```
1. You write: export default { async fetch(request) { ... } }
2. There is no app.listen(). You do not bind to a port. You do not start a process.
3. Instead, you export a "fetch handler" — a function that Cloudflare calls when an HTTP request arrives at their network
4. There is no long-running process. There is no process at all in the traditional sense.
5. When a request arrives at a Cloudflare edge location, that location looks at your Worker code
6. It creates a V8 isolate (explained in detail in the next section) just for this request
7. Your fetch() function runs inside that isolate
8. When your function returns a Response, the isolate is destroyed
9. The next request creates a completely new isolate
10. Nothing persists between requests unless you explicitly use a storage service (KV, Durable Objects, R2)
```

The key difference: there is no `app.listen()` because **you are not starting anything**. You are writing a function that the platform calls when it needs to. The platform manages the lifecycle, the scaling, the infrastructure.

This is the same model as serverless functions (AWS Lambda, Google Cloud Functions), but deployed at 330+ locations instead of one region.

### The Critical Misconception

A common thought: "If the isolate is destroyed after each request, doesn't that mean every request is a cold start?"

No. Cloudflare Workers has a **warm start** optimization. When a Worker handles a request, V8 keeps the compiled code in memory for a short time (typically seconds to minutes). If another request for the same Worker arrives quickly, the same isolate is reused. The compiled code is already in memory — the request handler runs immediately.

The difference from Node.js: in Node.js, the *process* is always running. In Workers, the *compiled code* is cached in memory, but the *isolate* may or may not be reused. The platform decides.

```
Cold start:
  Request arrives → no isolate available → V8 creates isolate → loads code → executes handler
  ~5ms on Cloudflare Workers

Warm start:
  Request arrives → isolate available in memory → executes handler directly
  ~0.5ms

Compare to Node.js cold start (for comparison, not relevant to Workers):
  ~50-100ms just for Node.js runtime init
```

---

## Part 2: V8 Isolates

### What V8 Is Actually Doing

V8 is the JavaScript engine that Chrome uses. It compiles JavaScript to machine code, manages memory, runs garbage collection. It's a C++ program that takes JavaScript source code and executes it.

A **V8 isolate** is one instance of the V8 engine. It's a self-contained execution environment with its own heap, its own garbage collector, its own set of compiled functions. An isolate shares nothing with other isolates.

```
One V8 process can contain MULTIPLE isolates:

┌─────────────────────────────────────────┐
│           V8 Process                     │
│                                          │
│  ┌────────────────────────────────┐      │
│  │ Isolate A (User request)       │      │
│  │  - Heap: 10MB                  │      │
│  │  - Running: fetch() handler    │      │
│  │  - GC: independent             │      │
│  └────────────────────────────────┘      │
│                                          │
│  ┌────────────────────────────────┐      │
│  │ Isolate B (User request)       │      │
│  │  - Heap: 8MB                   │      │
│  │  - Running: fetch() handler    │      │
│  │  - GC: independent             │      │
│  └────────────────────────────────┘      │
│                                          │
│  ┌────────────────────────────────┐      │
│  │ Isolate C (Idle, warm)         │      │
│  │  - Heap: 12MB                  │      │
│  │  - Loaded: compiled code       │      │
│  │  - Last used: 2s ago           │      │
│  └────────────────────────────────┘      │
└─────────────────────────────────────────┘
```

Each isolate is sandboxed — it cannot access the memory of other isolates. It cannot access the file system. It cannot open network sockets directly. It can only interact with the outside world through **bindings** that the platform provides (fetch, KV, R2, etc.).

This is fundamentally different from Node.js:

```
Node.js:
  One process per application.
  That process has access to everything: fs, net, process.env, require(), threads.
  Multiple requests share the same process and memory space.

V8 Isolate:
  One isolate per request (or per few requests, if warm).
  That isolate has no access to fs, no net (except fetch), no require() at runtime.
  The isolate is created, your code runs, the isolate is destroyed.
  The platform (Cloudflare) decides when to create and destroy isolates.
```

### The Constraints This Creates

Because isolates are short-lived and sandboxed, certain things are impossible:

1. **No file system.** You cannot read or write files. There is no disk. There is no `/tmp`. If you need persistent storage, you use Cloudflare KV (key-value store), R2 (object storage), or D1 (SQLite database).

2. **No open connections.** You cannot open a raw TCP/UDP socket. You cannot create a WebSocket server. You can only make outbound HTTP calls via `fetch()`.

3. **No process-level state.** You cannot store data in a global variable and expect it to be there on the next request. The isolate might be reused (in which case global variables survive), or it might not. You must assume state is reset on every request, or use explicit storage.

4. **No long-running computations.** Workers have a CPU time limit (30 seconds on the paid plan, 10 seconds on the free plan). If your function uses more CPU than that, the platform terminates it.

5. **Limited memory.** Each Worker gets 128MB. This is the heap size of the isolate. If you allocate more, the isolate is terminated.

### Why This Design Exists

The constraints are not limitations you have to work around — they're the entire point of the architecture. By making isolates stateless, short-lived, and sandboxed, Cloudflare can:

- Run hundreds of Workers from different customers on the same physical machine without them interfering with each other
- Spin up a new isolate in ~5ms because there's no OS to boot, no dependencies to install, no process to fork
- Scale to zero when there's no traffic, because creating an isolate costs nothing until a request arrives
- Move a Worker from one edge location to another without downtime, because there's no persistent state to migrate

This is the "no server" model. Not that there isn't hardware. But there is no process that you manage, no server you SSH into, no daemon you keep alive. You write a function. The platform calls it. The platform handles the rest.

---

## Part 3: What Is Hono and Why Does It Exist?

### The Framework Gap at the Edge

When you write a Cloudflare Worker without a framework, your code looks like this:

```js
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/users" && request.method === "GET") {
      return new Response(JSON.stringify(users), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (url.pathname.startsWith("/api/") && request.method === "GET") {
      return fetch(`https://backend.example.com${url.pathname}`);
    }

    return new Response("Not Found", { status: 404 });
  },
};
```

This works. But as your application grows — 20 routes, 10 middleware functions, error handling, CORS, authentication — this file becomes unmanageable. Every route is a nested if-statement. Every middleware is manually composed.

You could use Express. But Express was designed for Node.js — it assumes a long-running process, it assumes `req` and `res` are Node.js objects, it assumes `app.listen()`. Express does not run on Cloudflare Workers without a compatibility layer that simulates Node.js, which adds overhead and breaks at edge cases.

Hono exists to fill this gap. It provides Express-like routing and middleware in a package that:

1. **Does not require Node.js.** Hono runs on any JavaScript runtime that supports the Web API standard (Request, Response, fetch). This includes Cloudflare Workers, Deno, Bun, and Node.js.

2. **Compiles routes into an efficient trie.** Hono builds a route tree that maps a URL directly to its handler, without iterating through registered routes.

3. **Produces a 15KB bundle.** Hono's tree-shaken bundle is 15KB. Express is ~600KB. On the edge, bundle size matters because it affects cold start time — the platform must load your code over the network before running it.

4. **Uses platform-native objects.** Hono wraps the Web API Request and Response objects directly. Express creates its own `req` and `res` objects with additional methods. On the edge, there's no need for this abstraction — the platform already provides Request and Response.

### Hono's Architecture

**The Router**

When you write this in Express:

```js
app.get("/api/users/:id", handler);
app.post("/api/users", handler);
app.get("/api/users", handler);
```

Express stores these as an array. When a request arrives, Express loops through each entry until it finds a matching route. At N routes, a request takes O(N) time to find its handler.

When you write the same in Hono:

```js
app.get("/api/users/:id", handler);
app.post("/api/users", handler);
app.get("/api/users", handler);
```

Hono compiles these into a **trie** (a prefix tree). Each segment of the path is a node in the tree. When a request arrives, Hono walks the tree segment by segment — `/` → `api` → `users` → `:id`. This takes O(path-length) time, regardless of how many routes are registered.

For 100 routes:
- Express: up to 100 comparisons before finding the right handler
- Hono: exactly the number of path segments (e.g., 4 comparisons for `/api/users/:id`)

For 1000 routes, the difference becomes significant — especially on the edge, where every millisecond of CPU time counts.

**The Context Object**

Express creates `req` and `res` objects with additional methods (`req.params`, `req.query`, `res.json()`). These are created by extending the native Node.js objects, adding methods via prototype chains.

Hono creates a single `Context` object (typically named `c`). This object provides read-only access to the request and methods for constructing the response:

```js
app.get("/api/users/:id", (c) => {
  const id = c.req.param("id");     // path parameter
  const query = c.req.query("page"); // query parameter
  const body = c.req.header("Authorization"); // header
  return c.json({ id });             // JSON response
});
```

The `c.req` is a thin wrapper around the platform's native `Request` object. It doesn't create new objects until you ask for them. If you never call `c.req.param()`, the path isn't parsed.

**Middleware**

Hono middleware is a function that receives the context and a `next` function:

```js
app.use("/api/*", async (c, next) => {
  const start = Date.now();
  await next();
  const ms = Date.now() - start;
  console.log(`${c.req.method} ${c.req.url} ${c.res.status} ${ms}ms`);
});
```

The middleware calls `await next()` to pass control to the next middleware or route handler. After `next()` returns, the response is available as `c.res`. This is the same pattern as Express, but:

- In Express, middleware often modifies `req` and `res`. In Hono, middleware reads from `c.req` and `c.res`. The context is passed explicitly.
- In Express, middleware that doesn't call `next()` hangs the request. In Hono, the middleware stack has a timeout safety net, but the same principle applies.

**Adapters**

Hono provides adapters for different runtimes:

```js
// Cloudflare Worker
import { Hono } from "hono";
const app = new Hono();
export default app;

// Node.js
import { Hono } from "hono";
import { serve } from "@hono/node-server";
const app = new Hono();
serve(app);

// Bun
import { Hono } from "hono";
const app = new Hono();
export default app;

// Deno
import { Hono } from "hono";
const app = new Hono();
Deno.serve(app.fetch);
```

The same application code runs on all of them. The adapter handles the runtime-specific details (how to start listening, how to receive requests, how to send responses).

### Hono vs Express: The Real Differences

The differences are not about features — Hono supports routing, middleware, error handling, validation, and everything else Express does. The differences are architectural:

```
Startup:
  Express: Requires Node.js runtime initialization (~50ms), creates process,
           binds port, starts event loop. All this happens before any request.
  Hono: No runtime init. No port binding. Code is loaded when the first
        request arrives. The first request pays the compilation cost (~5ms).

Request Lifecycle:
  Express: The same process handles all requests. req and res are created per
           request but share the process heap. Middleware chains are built once.
  Hono: A new isolate may handle each request. Context is created per request.
        Middleware chain is evaluated per request using the compiled trie.

State:
  Express: Global variables persist across requests. In-memory caching works.
  Hono: Global variables may or may not persist (isolate reuse is not guaranteed).
        In-memory caching requires Durable Objects or explicit storage.

Bundle Size:
  Express: ~600KB (includes Node.js-specific code, connect middleware layer,
           route matching utilities, error handling infrastructure)
  Hono: ~15KB (tree-shaken, only includes what you use)

HTTP Objects:
  Express: Uses Node.js IncomingMessage and ServerResponse. Adds methods like
           res.json(), res.send(), res.status() by extending prototypes.
  Hono: Wraps the Web API Request and Response objects. No prototype extension.
        c.json() creates a new Response with JSON body.

Routing:
  Express: Linear search through registered routes. O(n) where n = route count.
           Router and application share the same route array.
  Hono: Trie-based routing. O(path-length). Route groups compile into subtrees.
        Router and application are separate concepts.

Middleware:
  Express: Middleware modifies req/res in-place. Order matters significantly.
           Error middleware must have 4 parameters (err, req, res, next).
  Hono: Middleware receives context and returns Response. Error middleware is
         registered with app.onError(). No signature tricks.
```

### When You Would Still Use Express

Hono is not a replacement for Express in every scenario. Use Express when:

- You are running a long-lived Node.js server that maintains in-memory state (WebSocket connections, server-sent events, in-process caches)
- You depend on npm packages that use Node.js-specific APIs (fs, net, crypto with native bindings)
- Your application spends most of its time in CPU-bound computation and would hit edge CPU time limits

Use Hono when:

- You want to deploy on Cloudflare Workers, Deno, or Bun
- You need low cold-start times
- You want the same codebase to run on edge and Node.js
- You are building an API gateway, proxy, or middleware-heavy application
- You want TypeScript-first development with strong inference

---

## Part 4: What We're Building — EdgeGate

EdgeGate is an API gateway that sits between your users and your backend services. Instead of users hitting your backend directly, they hit EdgeGate, and EdgeGate handles routing, rate limiting, caching, and logging.

Here's what it does:

```
User ──► edgegate.workers.dev
              │
              ▼
      ┌──────────────┐
      │  EdgeGate     │
      │               │
      │  1. Rate      │  Checks: has this IP exceeded the limit?
      │     Limiter   │  Uses: Cloudflare KV
      │               │
      │  2. Cache     │  Checks: is this response cached?
      │               │  Uses: Cloudflare KV
      │               │
      │  3. Router    │  Routes: /api/v1/* → JSONPlaceholder
      │               │          /api/v2/* → httpbin
      │               │          /health   → status
      │               │
      │  4. Logger    │  Logs: method, URL, status, latency
      │               │  Uses: Cloudflare Analytics Engine
      └──────────────┘
              │
              ▼
      Your backend services
```

We'll build it step by step. Each step adds one feature, and after each step we'll test it with curl so you can see exactly what changed.

### The Services We'll Route To

We'll use two free public APIs as our backend services:

- **JSONPlaceholder** (`jsonplaceholder.typicode.com`) — a fake REST API for prototyping. Returns JSON data for posts, users, todos.
- **httpbin** (`httpbin.org`) — a request/response debugging service. Returns whatever you send it.

You'll see EdgeGate forward requests to these services and cache the responses.

---

## Part 5: What Is Cloudflare KV?

Before we build anything, you need to understand the storage system we'll use for rate limiting and caching.

### The Problem

In Part 2, you learned that V8 isolates are destroyed after each request (or reused unpredictably). You cannot store data in a variable and expect it to be there on the next request:

```js
// This DOES NOT work at the edge
let requestCount = 0;

export default {
  async fetch(request) {
    requestCount++;  // ← This resets to 0 on every request
    return new Response(`Count: ${requestCount}`);
  },
};
```

A user requests this endpoint 10 times. They get "Count: 1" every time because each request runs in a fresh (or different) isolate. The variable `requestCount` is created, incremented, and destroyed with each request.

To persist data across requests, you need storage that lives outside the isolate.

### What Cloudflare KV Is

**KV** stands for Key-Value. It's a globally replicated database that lives on every edge location. When you write a value to KV, it's eventually replicated to all 330+ Cloudflare locations.

```
Your code (inside isolate):
  await KV.put("key", "value");  // Write

Cloudflare's internal network:
  KV.write → stored in local edge → replicated to other edges
  ~60 seconds for full global replication

Your code (inside isolate, maybe different location):
  const val = await KV.get("key");  // Read
  Returns: "value" (if replicated) or null (if not yet here)
```

**KV operations you need to know:**

```
KV.put(key, value, options)
  Stores a value. Options can include:
  - expirationTtl: time in seconds until auto-delete

KV.get(key)
  Reads a value. Returns the stored string or null.

KV.getWithMetadata(key)
  Reads a value and its metadata (additional data you stored with it).
```

**Why KV and not a normal database?**

- KV is accessible from any edge location. Your code runs in Tokyo. A write from Tokyo needs to be readable in London. KV handles this replication.
- KV has automatic TTL. You can set a value to expire after N seconds. This is perfect for rate limiting — old rate limit windows clean themselves up.
- KV has no connection pooling, no SQL queries, no schema. You put a string, you get a string.

### What We'll Store in KV

EdgeGate uses two KV namespaces (think of them as separate buckets):

```
RATE_LIMIT namespace:
  Key:   "ratelimit:1.2.3.4:17"   (IP address + time window)
  Value: "5"                       (request count for this IP in this window)
  TTL:   10 seconds                (window auto-expires)

CACHE namespace:
  Key:   "cache:GET:/api/v1/posts/1"  (HTTP method + URL path)
  Value: "{status:200, headers:{...}, body:...}" (serialized response)
  TTL:   60 seconds                     (cache duration)
```

---

## Part 6: Project Setup

We'll set up the project, configure KV, and write the first Hono application. Every command and every file is explained as we write it.

### Step 6.1: Install wrangler

Wrangler is the CLI tool for deploying Cloudflare Workers. It handles authentication, bundling your code, and deploying to Cloudflare's network.

```bash
npm install -g wrangler
```

Verify it installed:

```bash
wrangler --version
```

### Step 6.2: Authenticate with Cloudflare

```bash
wrangler login
```

This opens a browser. You log into your Cloudflare account and authorize wrangler. After this, wrangler can deploy Workers to your account. You need a free Cloudflare account — no credit card required for the Workers free plan.

### Step 6.3: Create the project directory

```bash
mkdir edgegate
cd edgegate
npm init -y
npm install hono
npm install -D @cloudflare/workers-types
```

`npm init -y` creates a `package.json` file. `npm install hono` installs the Hono framework. `npm install -D @cloudflare/workers-types` installs TypeScript type definitions for Cloudflare Workers (so your editor knows what `KVNamespace` and `AnalyticsEngineDataset` look like).

### Step 6.4: Configure TypeScript

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

This tells TypeScript to target modern JavaScript, use ESM module resolution, include Cloudflare Worker types, and produce type-checked output (without emitting files — wrangler handles compilation).

### Step 6.5: Create KV namespaces

We need two KV namespaces. Think of them as separate storage buckets:

```bash
wrangler kv:namespace create RATE_LIMIT
# Output: Created KV namespace with id: abc123def456...

wrangler kv:namespace create CACHE
# Output: Created KV namespace with id: 789ghi...-
```

Write down both IDs. You'll need them in the next step.

### Step 6.6: Configure wrangler

Create `wrangler.toml` — this file tells Cloudflare what your Worker is and what resources it needs:

```toml
name = "edgegate"
main = "src/index.ts"
compatibility_date = "2024-12-01"

[[kv_namespaces]]
binding = "RATE_LIMIT"
id = "abc123def456..."  # ← Paste the ID from step 6.5

[[kv_namespaces]]
binding = "CACHE"
id = "789ghi..."         # ← Paste the ID from step 6.5
```

Each field means:

- **`name`** — The name of your Worker on Cloudflare. Deploys to `edgegate.your-account.workers.dev`.
- **`main`** — Which file contains the fetch handler (the entry point).
- **`compatibility_date`** — Which version of the Workers runtime to use. Always set this to today's date or recent.
- **`[[kv_namespaces]]`** — Each block declares a KV namespace binding. `binding` is the JavaScript variable name you'll use in code (e.g., `c.env.RATE_LIMIT`). `id` is the namespace you created.

### Step 6.7: Project structure

```
edgegate/
├── wrangler.toml       # Worker configuration
├── package.json
├── tsconfig.json
├── src/
│   └── index.ts        # Our application code (starts small, grows)
```

We'll start with everything in one file. As it grows, we'll split into `middleware/` and `routes/` directories.

---

## Part 7: Building EdgeGate Step by Step

### Step 7.1: Hello World (First Route)

Let's start with the simplest possible Hono application — a single endpoint that returns "Hello Edge" to prove everything works.

Create `src/index.ts`:

```typescript
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => {
  return c.text("Hello Edge");
});

export default app;
```

**What each line does:**

- `new Hono()` — Creates the Hono application. This is your app object. You register routes and middleware on it.
- `app.get("/", handler)` — Registers a route. When an HTTP GET request arrives at `/`, the handler function runs. Hono supports `app.get()`, `app.post()`, `app.put()`, `app.delete()`, and `app.all()` (any method).
- `c.text("Hello Edge")` — Returns a plain text response. Hono provides `c.text()`, `c.json()`, `c.html()`, and `c.body()` for different response types.
- `export default app` — This is what Cloudflare Workers needs. Your fetch handler must be the default export. Hono's app satisfies the Worker's fetch handler interface.

**Run it locally:**

```bash
wrangler dev
```

This starts a local server at `http://localhost:8787`. Open it in your browser or:

```bash
curl http://localhost:8787/
# Response: Hello Edge
```

Congratulations. You just ran a Hono application on Cloudflare Workers. It's deployed to your local machine, but the same code runs on all 330+ Cloudflare locations when deployed.

### Step 7.2: Health Check Endpoint

Now let's add a health check — an endpoint that returns JSON with the status of the system. This is your first JSON response with Hono.

Add this route to `src/index.ts`:

```typescript
app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});
```

Your full file should now look like:

```typescript
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => {
  return c.text("Hello Edge");
});

app.get("/health", (c) => {
  return c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

export default app;
```

**What changed:**

- `c.json({...})` — Returns a JSON response. Hono automatically sets the `Content-Type: application/json` header.
- The health endpoint will grow later to check KV connectivity and upstream reachability. For now it just returns a static status.

**Test it:**

```bash
wrangler dev  # Make sure this is still running

curl http://localhost:8787/health
# Response: {"status":"healthy","timestamp":"2026-07-15T12:00:00.000Z"}
```

### Step 7.3: Proxy Routes (Forwarding Requests to a Backend)

Now for the core feature: EdgeGate as a proxy. When a request hits `/api/v1/*`, we forward it to JSONPlaceholder. When it hits `/api/v2/*`, we forward it to httpbin.

This is where we use `fetch()` inside a Worker — the same `fetch()` that runs in the browser, but on the server side.

```typescript
import { Hono } from "hono";

const app = new Hono();

app.get("/", (c) => c.text("Hello Edge"));

app.get("/health", (c) => {
  return c.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Proxy route: /api/v1/* → jsonplaceholder.typicode.com
app.get("/api/v1/*", async (c) => {
  // Step 1: Extract the path after /api/v1
  //   Request: GET /api/v1/posts/1
  //   url.pathname = "/api/v1/posts/1"
  //   targetPath = "/posts/1"
  const url = new URL(c.req.url);
  const targetPath = url.pathname.replace("/api/v1", "");

  // Step 2: Build the target URL
  const targetUrl = `https://jsonplaceholder.typicode.com${targetPath}${url.search}`;

  // Step 3: Forward the request using fetch()
  // fetch() inside a Worker sends an HTTP request to the target server
  // We forward the original request headers so the backend sees them
  const response = await fetch(targetUrl, {
    headers: c.req.raw.headers,
  });

  // Step 4: Add our own headers to the response
  const headers = new Headers(response.headers);
  headers.set("X-EdgeGate", "true");  // So the client knows it went through us

  // Step 5: Return the forwarded response
  return new Response(response.body, {
    status: response.status,
    headers,
  });
});

// Proxy route: /api/v2/* → httpbin.org
app.get("/api/v2/*", async (c) => {
  const url = new URL(c.req.url);
  const targetPath = url.pathname.replace("/api/v2", "");
  const targetUrl = `https://httpbin.org${targetPath}${url.search}`;

  const response = await fetch(targetUrl, {
    headers: c.req.raw.headers,
  });

  const headers = new Headers(response.headers);
  headers.set("X-EdgeGate", "true");

  return new Response(response.body, {
    status: response.status,
    headers,
  });
});

export default app;
```

**Understanding the proxy:**

The most important line is `c.req.raw.headers`. `c.req` is Hono's wrapper around the original HTTP request. `c.req.raw` gives you the raw `Request` object that Cloudflare created when the user's request arrived. Its `.headers` property contains all the original headers (Authorization, Content-Type, User-Agent, etc.). We forward these to the backend so the backend sees exactly what the client sent.

**Test it:**

```bash
# Restart wrangler dev if it's still running from before
# Stop it with Ctrl+C, then start again
wrangler dev
```

In a separate terminal:

```bash
# This should return a JSON post from JSONPlaceholder
curl http://localhost:8787/api/v1/posts/1
# Response: {"userId":1,"id":1,"title":"sunt aut facere...","body":"quia et suscipit..."}

# Check that our header was added
curl -v http://localhost:8787/api/v1/posts/1 2>&1 | grep X-EdgeGate
# Response: < X-EdgeGate: true
```

You are now proxying requests through EdgeGate to a real backend service. The user hits EdgeGate, EdgeGate hits JSONPlaceholder, and the response flows back.

### Step 7.4: What Is Cloudflare KV? (Full Explanation)

Now we add rate limiting and caching. Both need persistent storage. The only storage available to Workers at the edge is KV.

**KV is a key-value store replicated to all 330+ edge locations.** Here's exactly how it works:

```
When you write:
  await c.env.RATE_LIMIT.put("key", "value", { expirationTtl: 60 });

1. Your code (running in a V8 isolate at the Tokyo edge) calls put()
2. The C++ bridge sends an HTTP request to Cloudflare's KV service
3. KV stores the key-value pair in Tokyo's local storage
4. KV starts replicating to other edge locations
5. After ~60 seconds, the pair exists at all 330+ locations

When you read:
  const value = await c.env.RATE_LIMIT.get("key");

1. Your code calls get()
2. The C++ bridge checks local KV storage at the Tokyo edge
3. If the key was written locally (or has replicated), returns the value
4. If the key hasn't replicated yet, returns null
```

**KV has two important properties:**

1. **TTL (Time-To-Live)** — Every KV entry can have an expiration. After N seconds, the entry is automatically deleted. You don't need to clean it up manually.

2. **Eventual consistency** — A write in Tokyo is NOT immediately readable in London. It takes up to 60 seconds to replicate globally. For a single edge location, reads are strongly consistent with writes to that same location.

**How we use KV in EdgeGate:**

```
Rate limiting:
  Key format:  ratelimit:{IP address}:{window number}
  Value:       request count (string)
  TTL:         same as window size (auto-deletes old windows)

Caching:
  Key format:  cache:{HTTP method}:{URL path}?{query string}
  Value:       JSON with { status, headers, body }
  TTL:         cache duration (auto-expires stale entries)
```

### Step 7.5: Rate Limiter Middleware

Before we write the middleware, understand the algorithm. We're implementing a **sliding window** rate limiter:

```
Window size: 10 seconds
Max requests per window: 10

Time 0s:   Request 1 from IP 1.2.3.4 → count = 1
Time 3s:   Request 2 from IP 1.2.3.4 → count = 2
...
Time 9s:   Request 10 from IP 1.2.3.4 → count = 10
Time 11s:  Request 11 from IP 1.2.3.4 → count = 10, REJECT (429)

Time 11s:  window = floor(11 / 10) = 1 → new window starts
           If the 11th request arrives at T=11s, it falls in window 1,
           which has count 0. But wait — that would allow 10 more requests
           immediately after the first 10. The "sliding" part handles this:
```

Actually, this simple window-per-block works well enough for our demo. Let me simplify the explanation.

Create `src/config.ts`:

```typescript
export const CONFIG = {
  rateLimit: {
    maxRequests: 10,
    windowSeconds: 10,
  },
  cache: {
    defaultTTLSeconds: 60,
    cacheablePaths: ["/api/v1", "/api/v2"],
  },
  origins: {
    v1: "https://jsonplaceholder.typicode.com",
    v2: "https://httpbin.org",
  },
};
```

Create `src/middleware/rate-limiter.ts`:

```typescript
import { Context, Next } from "hono";
import { CONFIG } from "../config";

export async function rateLimiter(c: Context, next: Next) {
  // 1. Get the client's IP address
  // Cloudflare sends the real client IP in this header
  const ip = c.req.header("cf-connecting-ip") || "unknown";

  // 2. Calculate which time window we're in
  // If window is 10 seconds and time is 17 seconds since epoch:
  //   windowKey = floor(17 / 10) = 1
  // This creates a new window every 10 seconds
  const now = Math.floor(Date.now() / 1000);
  const windowKey = Math.floor(now / CONFIG.rateLimit.windowSeconds);

  // 3. Build the KV key
  // Format: ratelimit:{ip}:{windowNumber}
  // Example: ratelimit:1.2.3.4:176543
  const key = `ratelimit:${ip}:${windowKey}`;

  // 4. Read the current count from KV
  const kv = c.env.RATE_LIMIT as KVNamespace;
  const currentCount = await kv.get(key);

  // 5. Check if the IP has exceeded the limit
  if (currentCount) {
    const count = parseInt(currentCount, 10);
    if (count >= CONFIG.rateLimit.maxRequests) {
      // Return 429 Too Many Requests
      return c.json(
        {
          error: "Too Many Requests",
          retryAfter: CONFIG.rateLimit.windowSeconds,
        },
        429,
        {
          "Retry-After": String(CONFIG.rateLimit.windowSeconds),
        }
      );
    }
  }

  // 6. Increment the counter
  // parseInt returns NaN for empty strings, so we default to 0
  const newCount = (parseInt(currentCount || "0", 10) || 0) + 1;
  await kv.put(key, String(newCount), {
    expirationTtl: CONFIG.rateLimit.windowSeconds,
  });

  // 7. Allow the request to proceed
  await next();
}
```

**Understanding the sliding window:**

This is not a perfect sliding window — it creates fixed blocks of time. But it's good enough for our demo:

```
Window size: 10 seconds. maxRequests: 10.

T=0s    Request 1 → windowKey = floor(0/10) = 0 → key: ratelimit:ip:0 → count=1
T=5s    Request 2 → windowKey = floor(5/10) = 0 → key: ratelimit:ip:0 → count=2
T=9s    Requests 3-10 → windowKey = 0 → count=10
T=9.5s  Request 11 → windowKey = 0 → count=10, REJECTED (429)
T=11s   Request 12 → windowKey = floor(11/10) = 1 → key: ratelimit:ip:1 → count=1 (new window)

The window at TTL=10s for window 0 expires at T=10s, cleaning itself up.
```

**Register the middleware in `src/index.ts`:**

```typescript
import { Hono } from "hono";
import { rateLimiter } from "./middleware/rate-limiter";

type Bindings = {
  RATE_LIMIT: KVNamespace;
  CACHE: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

// Apply rate limiter to ALL routes
app.use("*", rateLimiter);

app.get("/", (c) => c.text("Hello Edge"));

app.get("/health", (c) => {
  return c.json({ status: "healthy", timestamp: new Date().toISOString() });
});

// Proxy routes (same as before)
app.get("/api/v1/*", async (c) => {
  const url = new URL(c.req.url);
  const targetPath = url.pathname.replace("/api/v1", "");
  const targetUrl = `https://jsonplaceholder.typicode.com${targetPath}${url.search}`;
  const response = await fetch(targetUrl, { headers: c.req.raw.headers });
  const headers = new Headers(response.headers);
  headers.set("X-EdgeGate", "true");
  return new Response(response.body, { status: response.status, headers });
});

app.get("/api/v2/*", async (c) => {
  const url = new URL(c.req.url);
  const targetPath = url.pathname.replace("/api/v2", "");
  const targetUrl = `https://httpbin.org${targetPath}${url.search}`;
  const response = await fetch(targetUrl, { headers: c.req.raw.headers });
  const headers = new Headers(response.headers);
  headers.set("X-EdgeGate", "true");
  return new Response(response.body, { status: response.status, headers });
});

export default app;
```

**Key line:** `type Bindings = { RATE_LIMIT: KVNamespace; CACHE: KVNamespace; }`. This tells TypeScript what Cloudflare resources are available. The binding names (`RATE_LIMIT`, `CACHE`) must match exactly what you wrote in `wrangler.toml`. They become properties of `c.env`.

**What `app.use("*", rateLimiter)` does:**

Every request — to `/`, `/health`, `/api/v1/*`, `/api/v2/*` — runs through the rate limiter before reaching the route handler. The `"*"` pattern means "match all paths." You can scope it: `app.use("/api/*", rateLimiter)` would only apply to API routes.

**Test it:**

```bash
# Need wrangler dev running. If it's running, stop and restart:
# wrangler dev

# Run this loop — the 11th request should return 429
for ($i = 0; $i -lt 12; $i++) {
  $resp = curl -s -o $null -w "%{http_code}" http://localhost:8787/health
  Write-Output "Request $($i+1): $resp"
}
```

Output:

```
Request 1: 200
Request 2: 200
...
Request 10: 200
Request 11: 429
```

The rate limiter stores the count in KV. Each request reads the current count, and when it reaches 10, subsequent requests get 429.

### Step 7.6: Response Caching Middleware

The cache middleware stores GET responses in KV so subsequent requests for the same URL get served from the edge instead of hitting the upstream service.

Create `src/middleware/cache.ts`:

```typescript
import { Context, Next } from "hono";
import { CONFIG } from "../config";

function isCacheable(c: Context): boolean {
  // Only cache GET requests
  if (c.req.method !== "GET") return false;

  // Only cache paths we configured as cacheable
  const url = new URL(c.req.url);
  return CONFIG.cache.cacheablePaths.some((path) =>
    url.pathname.startsWith(path)
  );
}

function cacheKey(c: Context): string {
  const url = new URL(c.req.url);
  return `cache:${c.req.method}:${url.pathname}${url.search}`;
}

export async function edgeCache(c: Context, next: Next) {
  // Step 1: Check if this request should be cached at all
  if (!isCacheable(c)) {
    await next();
    return;
  }

  const kv = c.env.CACHE as KVNamespace;
  const key = cacheKey(c);

  // Step 2: Try to read from cache
  const cached = await kv.get(key, { type: "text" });

  if (cached) {
    // Cache HIT — return the cached response
    const { status, headers, body } = JSON.parse(cached);
    headers["X-Cache"] = "HIT";  // Indicate it came from cache
    return c.newResponse(body, status, headers);
  }

  // Step 3: Cache MISS — let the request proceed to the route handler
  await next();

  // Step 4: After the route handler runs, we have c.res (the response)
  // If it was successful, store a copy in cache
  if (c.res && c.res.ok) {
    // Extract headers from the response
    const headers: Record<string, string> = {};
    c.res.headers.forEach((value, key) => {
      headers[key] = value;
    });

    // Clone the response body before reading it
    // A Response body can only be consumed once. Reading it here would
    // consume it before sending to the client. Cloning creates a copy.
    const body = await c.res.clone().text();

    const cachedValue = JSON.stringify({ status: c.res.status, headers, body });

    await kv.put(key, cachedValue, {
      expirationTtl: CONFIG.cache.defaultTTLSeconds,
    });
  }
}
```

**Understanding the cache:**

- **Cache key:** `cache:GET:/api/v1/posts/1?page=2` — includes the full URL with query parameters so different requests get different cached values.
- **Cache hit:** The stored response (status, headers, body) is parsed from JSON and returned as a new HTTP Response. The `X-Cache: HIT` header tells the client it was served from cache.
- **Cache miss:** The request continues to the route handler. After the handler runs, the response is stored in KV for future requests.
- **`c.res.clone().text()`:** This is critical. A Response object's body is a stream. Once you read it, it's gone. `clone()` creates a copy so we can read the body for caching while the original body is sent to the client.

**Register the cache middleware in `src/index.ts`:**

```typescript
import { Hono } from "hono";
import { rateLimiter } from "./middleware/rate-limiter";
import { edgeCache } from "./middleware/cache";

type Bindings = {
  RATE_LIMIT: KVNamespace;
  CACHE: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

// Middleware order matters: rate limiter runs first, then cache
app.use("*", rateLimiter);
app.use("/api/*", edgeCache);  // Only cache API routes

// Routes (same as before)
app.get("/", (c) => c.text("Hello Edge"));
app.get("/health", (c) => {
  return c.json({ status: "healthy", timestamp: new Date().toISOString() });
});
app.get("/api/v1/*", async (c) => {
  const url = new URL(c.req.url);
  const targetPath = url.pathname.replace("/api/v1", "");
  const targetUrl = `https://jsonplaceholder.typicode.com${targetPath}${url.search}`;
  const response = await fetch(targetUrl, { headers: c.req.raw.headers });
  const headers = new Headers(response.headers);
  headers.set("X-EdgeGate", "true");
  return new Response(response.body, { status: response.status, headers });
});
app.get("/api/v2/*", async (c) => {
  const url = new URL(c.req.url);
  const targetPath = url.pathname.replace("/api/v2", "");
  const targetUrl = `https://httpbin.org${targetPath}${url.search}`;
  const response = await fetch(targetUrl, { headers: c.req.raw.headers });
  const headers = new Headers(response.headers);
  headers.set("X-EdgeGate", "true");
  return new Response(response.body, { status: response.status, headers });
});

export default app;
```

**Test the cache:**

```bash
# First request — cache miss, fetches from JSONPlaceholder
curl -w "\nTime: %{time_total}s\n" http://localhost:8787/api/v1/posts/1
# Response should include X-EdgeGate: true but not X-Cache: HIT

# Second request — cache hit, served from KV
curl -w "\nTime: %{time_total}s\n" http://localhost:8787/api/v1/posts/1
# Response should include X-Cache: HIT and be noticeably faster
```

The first request goes to JSONPlaceholder (takes network time). The second request is served from KV at the edge (microseconds).

### Step 7.7: Error Handling and 404

Every production application needs to handle errors gracefully and return meaningful responses when a route doesn't match.

Add these to `src/index.ts`:

```typescript
// After all routes, before export default app:

// Catches any error thrown in middleware or route handlers
app.onError((err, c) => {
  console.error(`Unhandled error: ${err.message}`);
  return c.json({ error: "Internal Server Error" }, 500);
});

// Catches requests that don't match any registered route
app.notFound((c) => {
  return c.json({ error: "Not Found" }, 404);
});
```

**Test:**

```bash
curl http://localhost:8787/nonexistent
# Response: {"error":"Not Found"} (status 404)
```

### Step 7.8: Organizing the Code

When your application grows, having everything in one file becomes hard to manage. Let's split the routes into separate files.

Create `src/routes/health.ts`:

```typescript
import { Hono } from "hono";

const health = new Hono();

health.get("/", (c) => {
  return c.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
  });
});

export { health as healthRoutes };
```

Create `src/routes/proxy.ts`:

```typescript
import { Hono } from "hono";
import { CONFIG } from "../config";

const proxy = new Hono();

proxy.get("/v1/*", async (c) => {
  const url = new URL(c.req.url);
  const targetPath = url.pathname.replace("/api/v1", "");
  const targetUrl = `${CONFIG.origins.v1}${targetPath}${url.search}`;
  const response = await fetch(targetUrl, { headers: c.req.raw.headers });
  const headers = new Headers(response.headers);
  headers.set("X-EdgeGate", "true");
  return new Response(response.body, { status: response.status, headers });
});

proxy.get("/v2/*", async (c) => {
  const url = new URL(c.req.url);
  const targetPath = url.pathname.replace("/api/v2", "");
  const targetUrl = `${CONFIG.origins.v2}${targetPath}${url.search}`;
  const response = await fetch(targetUrl, { headers: c.req.raw.headers });
  const headers = new Headers(response.headers);
  headers.set("X-EdgeGate", "true");
  return new Response(response.body, { status: response.status, headers });
});

export { proxy as proxyRoutes };
```

Update `src/index.ts` to use the route files:

```typescript
import { Hono } from "hono";
import { rateLimiter } from "./middleware/rate-limiter";
import { edgeCache } from "./middleware/cache";
import { healthRoutes } from "./routes/health";
import { proxyRoutes } from "./routes/proxy";

type Bindings = {
  RATE_LIMIT: KVNamespace;
  CACHE: KVNamespace;
};

const app = new Hono<{ Bindings: Bindings }>();

app.use("*", rateLimiter);
app.use("/api/*", edgeCache);

// Mount routes under path prefixes
app.route("/health", healthRoutes);  // /health/* routes
app.route("/api", proxyRoutes);       // /api/* routes

app.onError((err, c) => {
  console.error(`Unhandled error: ${err.message}`);
  return c.json({ error: "Internal Server Error" }, 500);
});

app.notFound((c) => {
  return c.json({ error: "Not Found" }, 404);
});

export default app;
```

**What `app.route()` does:** It mounts all routes from a sub-app under a path prefix. `app.route("/health", healthRoutes)` means the routes defined in `healthRoutes` are now accessible under `/health`. If `healthRoutes` defines `GET /`, it becomes `GET /health`.

Now your project structure is:

```
edgegate/
├── wrangler.toml
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts
│   ├── config.ts
│   ├── middleware/
│   │   ├── rate-limiter.ts
│   │   └── cache.ts
│   └── routes/
│       ├── health.ts
│       └── proxy.ts
```

---

## Part 8: Running Locally

Start the local dev server:

```bash
wrangler dev
```

Test all features:

```bash
# 1. Hello
curl http://localhost:8787

# 2. Health check
curl http://localhost:8787/health

# 3. Proxy to JSONPlaceholder (first request — cache miss)
curl -v http://localhost:8787/api/v1/posts/1 2>&1

# 4. Same request again (cache hit)
curl -v http://localhost:8787/api/v1/posts/1 2>&1

# 5. Proxy to httpbin
curl http://localhost:8787/api/v2/anything

# 6. 404
curl http://localhost:8787/nonexistent

# 7. Rate limiting (run 11 times, 11th gets 429)
1..11 | ForEach-Object {
  $code = curl -s -o $null -w "%{http_code}" http://localhost:8787/health
  Write-Output "Request $_ : $code"
}
```

---

## Part 9: Deploying to Cloudflare

```bash
wrangler deploy
```

After a few seconds:

```
Successfully published your script to
 https://edgegate.your-account.workers.dev
```

Your Worker is now running at all 330+ Cloudflare edge locations.

Test the same features on the live URL:

```bash
# Replace with your actual URL
curl https://edgegate.your-account.workers.dev/health
curl https://edgegate.your-account.workers.dev/api/v1/posts/1
curl https://edgegate.your-account.workers.dev/api/v1/posts/1  # cached
```

### Custom Domain (Optional)

In `wrangler.toml`:

```toml
routes = [
  { pattern = "api.yourdomain.com/*", zone_name = "yourdomain.com" }
]
```

Then deploy again:

```bash
wrangler deploy
```

---

## Part 10: Testing the Edge Benefits

### Cold vs Warm Start

```bash
# First request — might be a cold start (~5ms)
curl -w "\nTotal time: %{time_total}s\n" -o $null -s \
  https://edgegate.your-account.workers.dev/health

# Second request — warm start (sub-millisecond at edge)
curl -w "\nTotal time: %{time_total}s\n" -o $null -s \
  https://edgegate.your-account.workers.dev/health
```

The first request may be slower if a new isolate was created. Subsequent requests reuse the warm isolate.

### Cache Performance

```bash
# First request — fetches from JSONPlaceholder
curl -w "\nTime: %{time_total}s\n" -o $null -s \
  https://edgegate.your-account.workers.dev/api/v1/posts/1

# Second request — served from KV cache at the edge
curl -w "\nTime: %{time_total}s\n" -o $null -s \
  https://edgegate.your-account.workers.dev/api/v1/posts/1
```

The second request should be significantly faster because the response is read from KV at the same edge location, not fetched from the upstream server.

### Rate Limiting

```bash
# Hit it 11 times — the 11th gets blocked
1..11 | ForEach-Object {
  $code = curl -s -o $null -w "%{http_code}" \
    https://edgegate.your-account.workers.dev/health
  Write-Output "Request $_ : $code"
}
```

---

## Part 11: What You Built (Request Trace)

Here's the complete path of a single request through EdgeGate:

```
1. You visit https://edgegate.your-account.workers.dev/api/v1/posts/1

2. DNS resolves to the nearest Cloudflare edge location
   (Tokyo if you're in Japan, Frankfurt if in Germany, etc.)

3. The edge location receives the request and finds:
   "There is a Worker at edgegate.your-account.workers.dev"

4. Cloudflare finds (or creates) a V8 isolate for your Worker
   → Creates isolate (~5ms if cold)
   → Your entire bundle is already compiled and in memory

5. The Worker's fetch handler receives the request
   Hono's trie matches: /api/v1/posts/1 → hits the proxy route

6. Middleware runs in order:
   a. Rate limiter reads KV → "3 requests in current window" → allowed
   b. Cache checks KV → "cache:GET:/api/v1/posts/1" → not found (miss)

7. Route handler runs:
   fetch("https://jsonplaceholder.typicode.com/posts/1")
   → This C++ function opens an HTTP connection to JSONPlaceholder
   → Sends the request
   → Gets the response

8. Response flows back through middleware:
   Cache middleware: stores the response in KV with 60s TTL
   Rate limiter: already ran (before the route)

9. The Response is returned to the edge location

10. The edge location sends the response to your browser

Total time: ~30-100ms (mostly the upstream fetch)
              → Next request: ~5-10ms (from cache at the edge)

On a subsequent request for the same URL:
  1-4: Same as above
  5:   Hono matches the route
  6a:  Rate limiter checks → "5 requests" → allowed
  6b:  Cache checks KV → "cache:GET:/api/v1/posts/1" → FOUND
  7:   Returns cached response immediately. No upstream fetch.
  8-10: Same as above
  
  Total time: ~5-10ms (all at the edge, no network to upstream)
```

---

## Key Takeaways

**Edge computing** runs your code on 330+ servers worldwide. Users are always served by the closest location. There is no `app.listen()` — you export a function, the platform calls it.

**V8 isolates** are sandboxed JavaScript execution environments. They're created per request, have no file system access, and can only interact with the outside world through bindings (fetch, KV, R2).

**Cloudflare KV** is a globally replicated key-value store. It persists data across requests at the edge. Operations are `get()`, `put()`, and `delete()` with optional TTL. Eventually consistent.

**Hono** is a framework that compiles routes into a trie for O(path-length) matching. It generates a 15KB bundle, wraps the platform's native Request/Response objects, and provides middleware, route grouping, error handling, and adapters for all runtimes.

**EdgeGate** is an API gateway running at the edge. It proxies requests to backend services, rate-limits per IP using KV, caches responses at the edge using KV, and demonstrates the core patterns of edge computing.

### Resources

- [Hono Documentation](https://hono.dev/)
- [Cloudflare Workers Documentation](https://developers.cloudflare.com/workers/)
- [Cloudflare KV Documentation](https://developers.cloudflare.com/kv/)
- [Wrangler CLI Reference](https://developers.cloudflare.com/workers/wrangler/)
- [JSONPlaceholder API](https://jsonplaceholder.typicode.com/)
- [httpbin](https://httpbin.org/)
