---
title: "Fastify: The Complete Guide — From Zero to Production"
date: "2026-7-18"
readTime: "35 min read"
category: "System Design"
---

## A Note Before We Start

You probably know Express. You've built APIs with it. You know middleware, routes, error handling. This guide assumes that baseline and answers one question: if Express has been the default Node.js framework for 15 years, why are companies switching to Fastify?

The answer isn't "it's faster" — though it is. The answer is that Fastify was designed for production from day one, while Express was designed for prototyping and grew into production organically. The difference shows in every aspect: validation, serialization, logging, plugin isolation, testing, and TypeScript support.

This guide covers everything: why Fastify exists, how it works internally, every lifecycle hook, the plugin system, schema validation, file structure patterns from real companies, testing, production deployment, and the tradeoffs that nobody talks about.

By the end, you'll know Fastify well enough to use it at any company — and you'll know when not to.

---

## Part 1: Why Fastify Exists

### The Express Problem

Express was released in 2010. It was designed for a different era of Node.js — before async/await, before TypeScript, before microservices, before JSON APIs were the default.

Express has no built-in validation. You add `joi`, `express-validator`, or `zod` yourself. It has no built-in serialization — every `res.json()` calls `JSON.stringify()` under the hood, walking your object tree at runtime. It has no built-in logging — you add `morgan` or `winston`. It has no built-in TypeScript support — you add `@types/express` from DefinitelyTyped.

None of these are dealbreakers. Express powers PayPal, Netflix, Uber, and LinkedIn. But every feature you need in production — validation, serialization, logging, TypeScript — is bolted on as a third-party library. Each library has its own API, its own performance characteristics, and its own bugs.

Fastify was created in 2017 by Matteo Collina (Node.js core contributor, Pino creator) to solve this: **a production Node.js framework with everything built in, designed for performance from the start.**

### The Numbers

Benchmarks tell a simplified story, but they're useful for understanding where Fastify's design decisions lead:

```
Framework                Requests/sec (hello world)
─────────────────────────────────────────────────
Raw Node.js http           74,513
Fastify 4.x                77,193
Koa 2.x                    54,272
hapi 20.x                  42,284
Express 4.x                14,200
```

Fastify is ~5x faster than Express on a simple JSON response. More importantly, with `fast-json-stringify` (its JSON serializer), the gap widens dramatically on larger payloads:

```
1KB JSON response:
  Express:  15,080 req/s
  Fastify: 77,193 req/s  (5x faster)

10KB JSON response:
  Express:   1,580 req/s
  Fastify:  21,078 req/s  (13x faster — serialization is the bottleneck)
```

These numbers are from synthetic benchmarks. In real production, the bottleneck is usually your database, not your framework. StreamLine Logistics migrated from Next.js API Routes to Fastify and saw:

- p99 latency: 870ms → 312ms (64% reduction)
- Error rate: 0.8% → 0.02%
- Monthly cost: $1,660 → $420 (75% reduction)

The database wasn't changed. The reduction came entirely from the framework layer — less overhead per request meant fewer concurrent requests hitting the database, which meant less queueing and contention.

### What a Production Framework Needs

A production Node.js framework needs:

1. **Validation** — every request body, query string, and params must be validated before your handler runs
2. **Serialization** — responses must be serialized efficiently, especially large payloads
3. **Logging** — structured, low-overhead logging with request IDs
4. **TypeScript** — full type inference, not community types
5. **Plugin isolation** — plugins shouldn't leak decorators, hooks, or state
6. **Testing utilities** — fast, HTTP-less testing via `.inject()`
7. **Schema-driven docs** — OpenAPI generation from route schemas

Fastify provides all of these out of the box. Express provides none — every one is a separate package.

---

## Part 2: Core Architecture

Fastify's performance comes from four internal components working together. Understanding them helps you understand why Fastify behaves the way it does.

### The Router: find-my-way

Fastify uses `find-my-way`, a radix-tree-based router. A radix tree (compressed trie) stores routes so that lookup time is **O(path-length) regardless of the number of routes**.

Express uses a linear router. Every request iterates through all registered routes until it finds a match. With 100 routes, Express checks up to 100 patterns per request. Fastify checks exactly one — the path length.

```
Express router (linear):
  GET /users/:id → check "GET /users" → no → check "GET /users/:id" → match
  With 100 routes, worst case is 100 checks per request.

Fastify router (radix tree):
  /users/:id
    ├── /users       → matched
    ├── /users/:id   → matched
    ├── /users/:id/posts → matched
    └── /users/:id/settings → matched
  Single tree traversal, O(path-length).
```

The radix tree also supports wildcards (`/users/*`), parameters (`/users/:id`), and regex (`/users/:id(\\d+)`) as single nodes in the tree. All are matched in a single pass.

### The Serializer: fast-json-stringify

When you call `reply.send({ user: { name: "Alice" } })`, Express calls `JSON.stringify()` on the object. `JSON.stringify` is a generic C++ function that walks the object at runtime, checking each property's type, handling circular references, and building the JSON string character by character.

Fastify pre-compiles serialization functions. You attach a **response schema** to a route, and Fastify generates an optimized serializer at startup:

```ts
import Fastify from "fastify";

const app = Fastify();

app.get<{ Reply: { user: { id: number; name: string; email: string } } }>(
  "/users/:id",
  {
    schema: {
      response: {
        200: {
          type: "object",
          properties: {
            user: {
              type: "object",
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
                email: { type: "string" },
              },
            },
          },
        },
      },
    },
  },
  async (request, reply) => {
    const user = await db.findUser(request.params.id);
    return { user };  // Fastify serializes this using the compiled function
  }
);
```

The `schema` property is a **route option** — the second argument to `app.get()`, `app.post()`, etc. Inside it, `response` describes what the response should look like for each status code. The key `200` is the status code; its value is a JSON Schema that describes the response body.

When the server starts, Fastify reads all route schemas and compiles a serializer function for each one. For the schema above, it generates roughly:

```ts
// Generated at startup, used at runtime — no JSON.stringify() call
function serializeReply200(data) {
  return `{"user":{"id":${data.user.id},"name":"${data.user.name}","email":"${data.user.email}"}}`;
}
```

This generated function:
- Accesses properties directly by name — no property walking
- Knows every property's type at compile time — no type checks at runtime
- Concatenates strings directly — no intermediate representation
- Is ~10x faster than `JSON.stringify` for large objects

**Without a response schema,** Fastify falls back to `JSON.stringify`. The performance benefit only kicks in when you provide schemas. In production, you should provide response schemas for every endpoint — but in practice, most teams only validate request bodies and use TypeBox schemas for response types (covered in Part 5).

### The Validator: Ajv (Another JSON Validator)

Fastify uses Ajv for request validation. Like the serializer, Ajv compiles JSON Schema into JavaScript functions at startup. You attach a **body schema** as a route option, just like the response schema:

```ts
import Fastify from "fastify";
import { Type } from "@sinclair/typebox";  // optional, TypeBox makes this cleaner

const app = Fastify();

app.post(
  "/auth/login",
  {
    schema: {
      body: {
        type: "object",
        required: ["email", "password"],
        properties: {
          email: { type: "string", format: "email" },
          password: { type: "string", minLength: 8 },
        },
      },
    },
  },
  async (request, reply) => {
    // If we reach here, body.email and body.password are VALID
    // Fastify already rejected invalid requests with 400
    const { email, password } = request.body;
    // ...
  }
);
```

The `schema.body` key tells Fastify: "validate the request body against this JSON Schema before the handler runs." If the body is missing `email`, or `password` is too short, Fastify returns a 400 response immediately — your handler never executes.

Ajv compiles this schema at startup into roughly: 
```ts
function validate(data) {
  if (typeof data !== "object") return false;
  if (typeof data.email !== "string") return false;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) return false;
  if (typeof data.password !== "string") return false;
  if (data.password.length < 8) return false;
  return true;
}
```

Validation runs automatically before your handler — no manual `if (!body.email) return 400` in every route. Invalid requests get a structured error response with field-level details.

**The tradeoff:** JSON Schema is verbose. A simple email validation takes 4 lines of schema vs 1 line of code. This verbosity is why TypeBox and Zod providers exist (covered in Part 5).

### The Logger: Pino

Fastify uses Pino as its logger. Pino is the fastest Node.js logger because of a key design decision: **it logs in JSON format with no async overhead.**

```ts
// Express: morgan logs in text, needs parsing
//   "GET /users 200 150ms"

// Fastify: Pino logs in JSON, structured by default
//   {"level":30,"time":1721234567890,"reqId":"req-1",
//    "req":{"method":"GET","url":"/users"},
//    "res":{"statusCode":200},"responseTime":150}
```

Request IDs are auto-generated and propagated through the entire request lifecycle. Every log line from a request includes its `reqId`, which makes debugging multi-request flows (a request that triggers queued jobs, webhooks, etc.) possible.

You can configure Pino for development readability:

```ts
const app = Fastify({
  logger: {
    transport: {
      target: "pino-pretty",
      options: { colorize: true },
    },
  },
});
```

In production, you ship raw JSON to your log aggregator (Datadog, Grafana Loki, ELK). No parsing step needed — Pino's output is valid JSON on every line.

---

## Part 3: The Request/Reply Lifecycle

This is the most important section for understanding Fastify. The lifecycle is not a simple middleware queue like Express — it has 8 distinct phases, each with its own purpose.

```
Incoming Request
      │
      ▼
┌──────────────────────┐
│  1. onRequest         │  ← Most common: auth, parsing headers
│     (hook)            │
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  2. preParsing        │  ← Modify raw body before parsing
│     (hook)            │     (encryption, compression)
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  3. Body Parsing      │  ← Internal: parses JSON/urlencoded/form
│     (internal)        │     based on Content-Type
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  4. preValidation     │  ← Modify parsed data before validation
│     (hook)            │     (default values, sanitization)
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  5. Validation        │  ← Internal: Ajv validates body/params/query
│     (internal)        │     against JSON Schema
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  6. preHandler        │  ← Authorization, permission checks
│     (hook)            │     (most common after onRequest)
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  7. Handler           │  ← Your route handler
│     (your code)       │
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  8. preSerialization  │  ← Modify response before serialization
│     (hook)            │     (add timestamps, wrap in envelope)
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  9. Serialization     │  ← Internal: fast-json-stringify
│     (internal)        │     compiles and runs serializer
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  10. onSend           │  ← Final modification before sending
│     (hook)            │     (add headers, compress)
└──────────────────────┘
      │
      ▼
┌──────────────────────┐
│  11. onResponse       │  ← After response sent to client
│     (hook)            │     (logging, metrics, cleanup)
└──────────────────────┘
```

The three hooks you'll use most:

**`onRequest`** — runs before anything. Use for: parsing `Authorization` header, tenant resolution from subdomain, request rate limiting, correlation ID injection.

```ts
app.addHook("onRequest", async (request, reply) => {
  const auth = request.headers.authorization;
  if (auth && auth.startsWith("Bearer ")) {
    const token = auth.slice(7);
    request.user = await verifyToken(token);  // Decorate request
  }
});
```

**`preHandler`** — runs after validation. Use for: authorization ("does this user have permission to call this route?"), loading resources needed by the handler, transaction management.

```ts
app.addHook("preHandler", async (request, reply) => {
  if (request.url === "/admin" && request.user?.role !== "admin") {
    reply.status(403).send({ error: "Forbidden" });
    return;  // Block execution — handler never runs
  }
});
```

**`onResponse`** — runs after the response is sent. Use for: logging, metrics, audit trails. The response is already sent — you cannot modify it here.

```ts
app.addHook("onResponse", async (request, reply) => {
  const latency = reply.elapsedTime;  // Built-in timing
  logger.info({ method: request.method, url: request.url,
    status: reply.statusCode, latency });
});
```

### How Express Users Get Confused

In Express, `next()` passes control to the next middleware. There's no distinction between "before handler" and "after handler" — middleware runs in registration order, and `next()` moves to the next function.

In Fastify, hooks run at specific lifecycle stages. If you want code to run after the handler (like `onResponse`), you use a dedicated hook — not `next()` after your handler code. This prevents the common Express error:

```ts
// Express — common pattern, works:
app.use((req, res, next) => {
  console.log("before");
  next();
  console.log("after");  // ← This runs after the handler
});

// Fastify — wrong approach:
app.addHook("preHandler", async (req, reply) => {
  console.log("before");
  // Can't run code "after" here because there's no next()
  // If you want "after", use onResponse hook
});

// Fastify — correct approach:
app.addHook("preHandler", async (req, reply) => {
  console.log("before");  // Runs before handler
});
app.addHook("onResponse", async (req, reply) => {
  console.log("after");  // Runs after response sent
});
```

---

## Part 4: The Plugin System

Fastify's plugin system is its most distinctive feature — and the one that surprises Express developers the most.

### Encapsulation

When you register a plugin in Fastify, the plugin gets its own scope. Anything created inside the plugin — decorators, hooks, content type parsers — is **invisible outside** unless explicitly shared.

```ts
// plugin-a.ts
export default async function pluginA(app: FastifyInstance) {
  app.decorate("secret", "password123");  // Only visible inside plugin A
  app.addHook("onRequest", async () => {
    console.log("Plugin A hook");  // Only runs for routes in plugin A
  });
}

// main.ts
app.register(pluginA);  // pluginA's decorators and hooks don't leak
app.register(pluginB);  // pluginB cannot access pluginA's "secret"

// Without fastify-plugin(), these are SILENTLY UNDEFINED
```

This is by design. Encapsulation prevents:
- **Plugin A** registering a hook that accidentally modifies requests for **Plugin B**'s routes
- **Plugin A** declaring a decorator name that conflicts with **Plugin B**
- Global state leaking across unrelated features

To share decorators across plugins, wrap the plugin with `fastify-plugin()`:

```ts
import fp from "fastify-plugin";

// auth-plugin.ts
export default fp(async function authPlugin(app: FastifyInstance) {
  app.decorate("authenticate", async (request: FastifyRequest, reply: FastifyReply) => {
    const token = request.headers.authorization?.slice(7);
    if (!token) throw new Error("Missing token");
    request.user = await jwt.verify(token);
  });
});

// Now any plugin registered AFTER this can use app.authenticate
```

**The rule:** Always wrap shared plugins with `fp()`. Encapsulate feature-specific plugins without `fp()`.

### How Real Companies Structure Plugins

Here's the plugin hierarchy Val Town uses in production:

```
app (root)
├── fp(cors)           ← Global: allowed origins
├── fp(auth)           ← Global: JWT verification, request.user
├── fp(db)             ← Global: Drizzle client, transaction helper
├── fp(error-handler)  ← Global: structured error responses
├── fp(rate-limit)     ← Global: per-IP rate limiting
│
├── register(routes/users)   ← Encapsulated: user CRUD
│   └── preHandler: checkAdminRole
│
├── register(routes/billing) ← Encapsulated: subscription management
│   └── preHandler: checkBillingAccess
│   └── preHandler: loadSubscription
│
├── register(routes/admin)   ← Encapsulated: admin-only endpoints
│   └── onRequest: adminAuthCheck
│   └── preHandler: auditLogAction
```

Shared plugins (`fp()`) go first. Feature plugins are registered in their own scope, with their own hooks that don't affect other features.

### Decorators

Decorators add properties to the `request`, `reply`, and `app` objects. They're the Fastify equivalent of `req.user = ...` in Express.

```ts
// Adding to app (available via app.getDecoratorName)
app.decorate("config", CONFIG);

// Adding to request (available in handlers as request.user)
app.decorateRequest("user", null);

// Adding to reply (available as reply.metrics)
app.decorateReply("metrics", { startTime: Date.now() });
```

TypeScript requires declaring the decorated types:

```ts
declare module "fastify" {
  interface FastifyRequest {
    user: { id: number; role: string } | null;
  }
  interface FastifyReply {
    metrics: { startTime: number };
  }
}
```

---

## Part 5: Schema Validation & Type Providers

### The Verbosity Problem

JSON Schema is powerful but verbose. Here's a simple user creation schema:

```json
{
  "body": {
    "type": "object",
    "required": ["name", "email", "password"],
    "properties": {
      "name": { "type": "string", "minLength": 1 },
      "email": { "type": "string", "format": "email" },
      "password": { "type": "string", "minLength": 8 },
      "age": { "type": "integer", "minimum": 0, "maximum": 150 }
    }
  }
}
```

This is 15 lines for 4 fields. In TypeScript, you also need a type:

```ts
interface CreateUserBody {
  name: string;
  email: string;
  password: string;
  age?: number;
}
```

Now you maintain two definitions — the JSON Schema for validation and the TypeScript type for your code. They get out of sync.

### Type Providers Solve This

Type providers let you define validation schemas using TypeScript-native syntax. Fastify supports two main ones:

**TypeBox** (recommended by Fastify team) — uses JSON Schema as its foundation:

```ts
import { Type } from "@sinclair/typebox";

const CreateUserSchema = Type.Object({
  name: Type.String({ minLength: 1 }),
  email: Type.String({ format: "email" }),
  password: Type.String({ minLength: 8 }),
  age: Type.Optional(Type.Integer({ minimum: 0, maximum: 150 })),
});
// TypeBox infers: { name: string; email: string; password: string; age?: number }
```

**Zod** — more ergonomic, larger ecosystem:

```ts
import { z } from "zod";

const CreateUserSchema = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  password: z.string().min(8),
  age: z.number().int().min(0).max(150).optional(),
});
```

Both infer TypeScript types at compile time and generate Fastify-compatible validation schemas at runtime.

### Which One to Use

| | TypeBox | Zod |
|---|---|---|
| **Bundle size** | ~15KB | ~30KB |
| **Speed** | Faster (JSON Schema native) | Slower (converts to JSON Schema at runtime) |
| **Type inference** | Exact (JSON Schema → TypeScript) | Exact (Zod → TypeScript) |
| **Ecosystem** | Fastify-native, smaller | Massive ecosystem (z.infer, z.output, parsers for anything) |
| **Error messages** | Raw Ajv errors | Customizable error messages |
| **When to use** | API-first, high throughput, Fastify-only | Full-stack, shared validation with frontend, complex logic |

**My recommendation:** If you're building an API-only backend, use TypeBox — it's faster, more compact, and natively designed for Fastify. If you're building a full-stack app where the frontend also validates with Zod, use Zod to share schemas between frontend and backend.

### What Happens at Runtime

When you register a route with a validation schema:

```ts
app.post(
  "/users",
  {
    schema: {
      body: TypeBoxObjectToJsonSchema(CreateUserSchema),
    },
  },
  async (request, reply) => {
    // request.body is fully typed and validated
    // If body is invalid, the handler NEVER runs
    // Fastify returns 400 with error details automatically
  }
);
```

This is the key advantage over Express: **validation failures never reach your handler.** A malformed body generates a 400 response before your code executes. In Express, you have to manually validate in every handler or install a middleware that wraps all routes.

### Response Validation

You can also validate (and serialize) responses:

```ts
app.get(
  "/users/:id",
  {
    schema: {
      response: {
        200: Type.Object({
          id: Type.Integer(),
          name: Type.String(),
          email: Type.String(),
        }),
      },
    },
  },
  handler
);
```

Fastify serializes the response using the compiled serializer for this schema. If your handler returns data that doesn't match the schema (e.g., missing a required field), Fastify throws an error.

**Production reality:** Most teams only validate request bodies and params. Response serialization is typically handled at the OpenAPI/docs level, not enforced at runtime. The serializer is still used for performance, but strict response validation often causes more problems than it solves in a changing API.

---

## Part 6: File Structure Patterns

There's no single "correct" Fastify file structure. Companies use different patterns based on team size and application complexity. Here are four real-world patterns.

### Pattern 1: Flat (Small API, 1-2 developers)

```
src/
├── index.ts            # App creation, plugin registration
├── routes/
│   ├── users.ts        # All user routes
│   └── health.ts       # Health check
├── plugins/
│   └── auth.ts         # Auth decorator
└── lib/
    └── db.ts           # Database client
```

Used for: Microservices, internal APIs, early-stage products.
Good for: Rapid iteration, minimal boilerplate.
Bad for: More than 10 routes, more than 2 developers.

### Pattern 2: Modular by Feature (Most Common)

```
src/
├── index.ts
├── app.ts               # Plugin registration, hook setup
├── lib/
│   ├── config.ts
│   ├── logger.ts
│   └── db.ts
├── modules/
│   ├── users/
│   │   ├── users.routes.ts
│   │   ├── users.service.ts
│   │   ├── users.schema.ts
│   │   └── users.test.ts
│   ├── billing/
│   │   ├── billing.routes.ts
│   │   ├── billing.service.ts
│   │   ├── billing.hooks.ts      # Feature-specific hooks
│   │   └── billing.test.ts
│   └── health/
│       ├── health.routes.ts
│       └── health.test.ts
└── plugins/
    ├── auth.ts
    ├── cors.ts
    ├── error-handler.ts
    └── swagger.ts
```

Used for: Medium-to-large APIs, teams of 3-10.
Good for: Clear ownership (each module is a Fastify plugin with its own scope).
Bad for: Cross-module logic requires shared services.

This is what most companies use. Each module is a Fastify plugin with its own hooks, schemas, and tests.

### Pattern 3: Hexagonal (Enterprise, Multiple Teams)

```
src/
├── index.ts
├── server/
│   ├── app.ts             # Fastify setup
│   ├── plugins/           # Fastify-specific
│   └── routes/            # Route definitions only
├── domain/                # Business logic (NO Fastify imports)
│   ├── users/
│   │   ├── user.entity.ts
│   │   ├── user.service.ts
│   │   └── user.repository.ts
│   └── billing/
│       ├── invoice.entity.ts
│       └── billing.service.ts
├── infrastructure/        # External integrations
│   ├── database/
│   │   └── drizzle/
│   ├── cache/
│   │   └── redis/
│   └── messaging/
│       └── kafka/
└── shared/
    ├── errors.ts
    └── types.ts
```

Used for: Large applications, multiple teams owning different domains.
Good for: Testability (domain has zero infrastructure dependencies), swapping frameworks without touching business logic.
Bad for: Overhead — every new feature touches 3+ layers.

### Pattern 4: Monorepo (Multiple Services)

```
packages/
├── shared/
│   ├── schemas/         # Shared TypeBox/Zod schemas
│   ├── config/          # Shared config
│   └── types/           # Shared TypeScript types
├── api-gateway/
│   ├── src/
│   └── package.json
├── users-service/
│   ├── src/
│   └── package.json
├── billing-service/
│   ├── src/
│   └── package.json
└── package.json         # Workspace root
```

Used for: Microservices with shared types across services.
Good for: TypeScript schema sharing (infer types once, use everywhere).
Bad for: Infrastructure complexity, versioning.

### What Companies Actually Do

Based on ~30 production Fastify codebases I've seen or read about:

- **Val Town** uses Pattern 2 (modular by feature) with their entire public API as one Fastify app
- **Mercedes-Benz developer API** uses Pattern 3 (hexagonal) — their API serves as the gateway to multiple vehicle APIs
- **Startups** typically start with Pattern 1 and migrate to Pattern 2 around 20 routes

**Start with Pattern 2.** It's the sweet spot. Each module is a Fastify plugin, encapsulated, testable, and owned by one person or team.

---

## Part 7: Error Handling

### The Default Behavior

Fastify has a default error handler that returns:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "body must have required property 'email'"
}
```

For validation errors, it includes field-level details:

```json
{
  "statusCode": 400,
  "error": "Bad Request",
  "message": "body/email must match format \"email\"",
  "validation": [
    {
      "keyword": "format",
      "instancePath": "/email",
      "schemaPath": "#/properties/email/format"
    }
  ]
}
```

### Custom Error Handler

Override globally:

```ts
app.setErrorHandler((error, request, reply) => {
  // Log the full error internally
  request.log.error(error);

  // Return a safe, structured response to the client
  reply.status(error.statusCode || 500).send({
    error: {
      code: error.code || "INTERNAL_ERROR",
      message: error.statusCode === 500
        ? "An unexpected error occurred"
        : error.message,
    },
  });
});
```

### Creating Custom Errors

Fastify supports typed errors:

```ts
import { createError } from "@fastify/error";

const InsufficientFunds = createError("INSUFFICIENT_FUNDS",
  "Account %s has insufficient balance. Available: %d", 422);

// In your handler:
throw new InsufficientFunds(accountId, balance);
// Response: {"statusCode":422,"error":"Unprocessable Entity",
//            "message":"Account 123 has insufficient balance. Available: 50"}
```

### 404 Handler

```ts
app.setNotFoundHandler((request, reply) => {
  reply.status(404).send({
    error: "Not Found",
    message: `Route ${request.method} ${request.url} not found`,
  });
});
```

### The Async Error Trap

Fastify automatically catches thrown errors and rejects from async handlers. You don't need `try/catch` around your handler logic:

```ts
// This works — Fastify catches the error and calls the error handler
app.get("/users/:id", async (request, reply) => {
  const user = await db.users.findById(request.params.id);
  if (!user) throw new NotFoundError("User not found");
  return user;
});
```

In Express (even with Express 5), you need `next(error)` or async wrapper middleware. Fastify handles this natively.

---

## Part 8: Testing

### The inject() Method

Fastify's `inject()` lets you test routes without starting an HTTP server. It constructs a request, runs it through the full lifecycle, and returns a response — all in-process:

```ts
import { test } from "vitest";
import { buildApp } from "../app";  // Helper that creates your Fastify instance

test("GET /health returns 200", async () => {
  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/health",
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    status: "healthy",
  });
});
```

No `app.listen()`, no `supertest`, no port conflicts, no `beforeAll/afterAll` for server start/stop. Each test creates a fresh app instance — tests are fully isolated.

### Testing with Database

For integration tests, create the app with a test database:

```ts
// test-helper.ts
import Fastify from "fastify";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";

export function buildTestApp() {
  const app = Fastify({ logger: false });  // Disable logging in tests

  // Use SQLite in-memory for tests
  const db = drizzle(createClient({ url: ":memory:" }));

  app.decorate("db", db);
  app.register(appModule);  // Register your routes

  return app;
}
```

### Snapshot Testing for Serialization

When you use response schemas, snapshot the serialized output to catch changes:

```ts
test("user response schema", async () => {
  const app = buildApp();
  const response = await app.inject({
    method: "GET",
    url: "/users/1",
  });

  expect(response.json()).toMatchSnapshot();
  // If you change the schema, the snapshot test fails
  // — you review the diff and update the snapshot
});
```

---

## Part 9: Production Checklist

### Graceful Shutdown

Fastify handles `SIGTERM` and `SIGINT` natively — it stops accepting new requests, waits for in-flight requests to complete, then exits. You can add custom cleanup:

```ts
app.addHook("onClose", async (instance) => {
  await db.close();
  await redis.disconnect();
  logger.info("Server shut down gracefully");
});
```

### Health Check Endpoint

Every production Fastify app needs a health check:

```ts
import fp from "fastify-plugin";

export default fp(async function healthPlugin(app: FastifyInstance) {
  app.get(
    "/health",
    {
      schema: {
        response: {
          200: Type.Object({
            status: Type.String(),
            timestamp: Type.String(),
            uptime: Type.Number(),
          }),
        },
      },
    },
    async () => {
      return {
        status: "healthy",
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
      };
    }
  );
});
```

For production deployments behind load balancers, add deep checks (database connectivity, cache connectivity) that return 503 on failure.

### CORS

```ts
app.register(import("@fastify/cors"), {
  origin: ["https://myapp.com", "https://admin.myapp.com"],
  methods: ["GET", "POST", "PUT", "DELETE"],
  credentials: true,
});
```

### Rate Limiting

```ts
app.register(import("@fastify/rate-limit"), {
  max: 100,
  timeWindow: "1 minute",
  keyGenerator: (request) => request.ip,
  errorResponseBuilder: (request, context) => ({
    statusCode: 429,
    error: "Too Many Requests",
    message: `Rate limit exceeded. Retry after ${context.after}`,
    retryAfter: context.after,
  }),
});
```

### OpenTelemetry

Fastify has built-in OpenTelemetry integration via `@fastify/otel`:

```ts
app.register(import("@fastify/otel"), {
  serviceName: "billing-api",
  exporter: new OTLPTraceExporter({
    url: "http://otel-collector:4318/v1/traces",
  }),
});
```

Every route, hook, and serialization step is instrumented automatically. Request traces include child spans for database queries and external API calls.

### Compression

```ts
app.register(import("@fastify/compress"), {
  global: true,       // Compress all responses
  threshold: 1024,    // Only compress responses > 1KB
  brotli: true,       // Enable brotli (if available)
});
```

### OpenAPI / Swagger

```ts
app.register(import("@fastify/swagger"), {
  openapi: {
    info: { title: "My API", version: "1.0.0" },
    servers: [{ url: "https://api.myapp.com" }],
  },
});

app.register(import("@fastify/swagger-ui"), {
  routePrefix: "/docs",
});
```

Fastify reads your route schemas and generates OpenAPI docs automatically. Every validated field appears in the docs with its type, constraints, and examples.

---

## Part 10: Real Companies Using Fastify

### Val Town — Incremental Migration

Val Town is a serverless "val" platform (small server-side scripts). Their public API was originally Express. They migrated to Fastify route-by-route using `@fastify/express` to run the old Express handler inside the new Fastify app:

```
Phase 1: Wrap Express inside Fastify
  app.register(@fastify/express)
  → All Express routes continue working
  → New routes are registered as Fastify routes

Phase 2: Migrate routes one at a time
  → Each route gets a Fastify implementation
  → Old Express handler is removed when migration is verified

Phase 3: Remove @fastify/express
  → All routes are now Fastify-native
```

They chose Fastify for: comprehensive plugin ecosystem (rate limiting, tracing, Sentry), built-in validation and serialization, OpenTelemetry integration out of the box, and the ecosystem's responsiveness to issues.

### Mercedes-Benz Developer API

Mercedes-Benz uses Fastify for their developer API platform (developer.mercedes-benz.com). It's an official Fastify sponsor. Their API serves as a gateway to vehicle data — authentication, vehicle status, and telemetry.

Their architecture uses Fastify's plugin system to isolate each vehicle API feature, with shared authentication and rate limiting at the global plugin level.

### StreamLine Logistics — 64% Latency Reduction

StreamLine Logistics ran a Next.js API on Vercel. A marketing campaign caused 2.3x normal traffic. Next.js API Routes hit concurrency limits, causing 4.2% error rates and p99 latency spiking to 2.1 seconds.

They migrated to Fastify on self-hosted AWS. Results over 30 days:

- p99 latency: 870ms → 312ms (64% reduction)
- Error rate: 0.8% → 0.02%
- Monthly cost: $1,660 → $420 (75% reduction)
- Memory footprint: 180MB per function → 12MB per process

The database wasn't changed. The improvement came from Fastify's lower overhead per request, which meant fewer concurrent database connections and less queueing.

### Strapi

Strapi (open-source headless CMS) uses Fastify as an API gateway. They published a guide on building production-ready APIs with Fastify. Their use case demonstrates Fastify in a content management context — complex query parameters, filtering, and pagination.

---

## Part 11: When NOT to Use Fastify

### 1. You Depend on Express-Specific Middleware

Some middleware only exists for Express. Certain `passport.js` strategies, `express-session`, and `connect-redis` have no direct Fastify equivalents. You can use `@fastify/express` to run Express middleware inside Fastify, but this:

- Defeats the performance benefit (Express middleware runs in Express's context)
- Adds complexity (two middleware systems)
- Prevents you from using Fastify hooks alongside Express middleware cleanly

**The tradeoff:** If you need a specific Express middleware that has no Fastify equivalent, evaluate whether the migration is worth the effort. Sometimes it's better to stay on Express.

### 2. Your Team Only Knows Express

Fastify's plugin encapsulation and lifecycle hooks are a different mental model. A team that knows Express well will take 1-2 weeks to become productive in Fastify. During that time, they will make mistakes:

- Decorating without `fp()` and wondering why it's `undefined` in routes
- Putting `reply.send()` in both the handler and a hook, causing `FST_ERR_REP_ALREADY_SENT`
- Using `return` and `reply.send()` in the same handler (which is a Fastify v5 error)

**The tradeoff:** Performance and built-in features vs. team learning curve and migration cost. If your team is shipping features on a tight deadline, delaying the migration might be the right call.

### 3. You Need Minimal Overhead for a Lambda

Fastify has startup time. It compiles routes, builds serializers, registers plugins. On Cloudflare Workers or Lambda@Edge, the cold start includes this compilation time. Hono, which is designed for edge runtimes, has a ~14KB bundle and zero startup compilation.

**The tradeoff:** For a simple Lambda function with 1-2 routes, the overhead of Fastify's compilation isn't justified. For a complex API with 50+ routes running on a server (Docker, EC2, ECS), Fastify's compilation cost is paid once at startup and amortized over millions of requests.

### 4. You're Building a Prototype

If you're building a proof-of-concept that will be thrown away, Express is faster to write. You don't need JSON Schema or TypeBox or plugin encapsulation. You need to move fast and break things.

**The tradeoff:** Express for prototyping → Fastify for production is a valid migration path. Val Town did exactly this.

### 5. You Need WebSocket-Native Features

Fastify supports WebSocket via `@fastify/websocket`, but it's not as mature as Socket.IO (Express) or `ws` directly. Complex real-time features (rooms, namespaces, fallback transports) are easier to implement outside Fastify.

**The tradeoff:** Use Fastify for your REST API and a separate WebSocket server (or use Socket.IO with a shared Redis adapter).

---

## Summary

Fastify is a production Node.js framework designed from the ground up for what Express evolved into: JSON APIs, TypeScript, schema validation, structured logging, and microservices.

Its advantages are real: 5x throughput over Express on synthetic benchmarks, built-in validation and serialization that eliminate entire categories of bugs, plugin encapsulation that prevents middleware order issues, and a testing model (`inject()`) that makes unit tests faster and more reliable.

Its tradeoffs are real too: a learning curve for Express developers, slower cold starts than edge-native frameworks, and a smaller middleware ecosystem.

**Choose Fastify when:** You're building a JSON API in production, your team is comfortable with TypeScript, and you want the framework to handle validation, serialization, and logging without third-party packages.

**Don't choose Fastify when:** You need an Express-specific middleware, your team is in the middle of a tight deadline, or you're deploying to edge runtimes where bundle size matters more than runtime performance.

The next article in this series will cover the Multi-Tenant Wallet API — optimistic locking, idempotency, Drizzle transactions, and Fastify's plugin system in a real project. This foundation is everything you need to follow along.
