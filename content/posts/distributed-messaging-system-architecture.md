---
title: "Building a Production Distributed Messaging System: Architecture, Tradeoffs, and the Plan"
date: "2025-11-26"
readTime: "10 min read"
category: "Distributed Systems"
---

## Building a Production Distributed Messaging System: The Architecture, The Problems, and The Plan

You open Discord. You type a message and hit enter. Half a second later, every person online in that channel sees it — whether they are on the same server node as you or a completely different one on the other side of the world. The message is not lost when a server crashes. The order of messages is consistent across all clients. A channel with 50,000 members behaves the same as a channel with 10.

This is not magic. It is a set of distributed systems problems, each with a known solution, each involving real tradeoffs. This post is the design document for a system that solves all of them. Not a tutorial project. Not a clone. A production-grade distributed messaging backend built the way a senior engineer would approach it at a real company — every technology chosen for a specific reason, every tradeoff made explicitly, every problem understood before a line of code is written.

This is post zero of the series. If you read it and understand every decision, the implementation posts that follow will make complete sense. If you skip it, the code will be confusing.

---

## What We Are Actually Building

Before anything else, a precise problem statement. Vague requirements produce vague systems.

**The system must:**

- Let users create **servers**. Servers contain **channels**. Users send messages to channels.
- Deliver every message to every **online** member of that channel **within one second** of it being sent.
- **Never lose a message** that was acknowledged to the sender — a server crash after confirming a send must not lose the message.
- Guarantee that **message order is consistent** — two users reading the same channel see messages in the same sequence.
- **Scale horizontally** — adding more server nodes increases capacity.
- Handle a channel with 50,000 members without degrading performance for other channels.

These are the same requirements Discord, Slack, and every serious messaging platform have had to solve. The solutions are known. The challenge is implementing them correctly and understanding why each solution is the right one.

---

## The Problems — One by One

Take what looks like a simple operation: one user sends a message. Here is what actually needs to happen:

```
1. Client sends the message to the API
2. API authenticates the user
3. API validates the user is a member of this channel
4. Message is written to storage — durably, so it survives crashes
5. A unique, ordered ID is assigned to the message
6. The system finds every online member of this channel
7. The message is pushed to each of those members' open connections
8. Members connected to different server nodes also need to receive it
9. Offline members need to be able to fetch it when they reconnect
```

Each step in that chain is a problem. Let's go through them.

---

### Problem 1: Where Do You Store Messages?

Your first instinct is a `messages` table in PostgreSQL. That works for thousands of users. It does not work for millions.

A busy channel generates hundreds of messages per minute. Across thousands of channels, you are writing millions of rows per day — every day, forever. A single PostgreSQL instance will eventually run out of disk, run out of write throughput, and become the bottleneck for the entire system.

You need to **shard** — split the data across multiple nodes. But shard by what? The choice of shard key determines everything:

- **Shard by user ID**: all messages from one user go to the same node. But querying "give me all messages in this channel" now requires hitting every shard. Terrible read performance.
- **Shard by message ID**: messages are randomly distributed. Same problem — channel history requires querying every shard.
- **Shard by channel ID**: all messages in one channel go to the same node. Querying channel history hits exactly one node. This is the right answer.

But shard by channel ID alone creates a second problem: a popular channel active for five years accumulates millions of messages on a single node. That node fills up. You need a way to split a channel's messages across nodes as it grows.

The solution is **time bucketing**: shard by `(channel_id, time_bucket)` where the bucket is something like the month number since a fixed epoch. All messages in channel X during month Y go to the same shard. As months pass, new shards are created automatically. No single shard grows unbounded.

This is exactly what Discord uses. It is not a clever trick — it is the correct solution to a specific constraint imposed by the data's access pattern.

---

### Problem 2: How Do You Order Messages Globally?

Two users send messages at the exact same millisecond on two different server nodes. Which message is "first"?

**Option 1 — Database auto-increment**: a single sequence that increments for every message. Ordering is guaranteed. But you now have a single writer — every message insert anywhere in the system must go through that one sequence generator. This is a global bottleneck. Ruled out.

**Option 2 — UUID**: globally unique, generates locally on any node with no coordination. But UUIDs have no ordering — you cannot sort them by time. Ruled out.

**Option 3 — Timestamp**: attach a millisecond timestamp and sort by it. But clocks on different machines drift. Two messages at the "same" millisecond from different nodes have ambiguous order, and clock skew of 10–50ms is normal. Ruled out as the primary ordering mechanism.

**Option 4 — Snowflake ID**: a 64-bit integer composed of three fields:

```
┌──────────────────────────────────┬────────────┬──────────────┐
│          Timestamp               │ Machine ID │   Sequence   │
│          41 bits                 │  10 bits   │   12 bits    │
│   milliseconds since an epoch    │            │              │
└──────────────────────────────────┴────────────┴──────────────┘
```

- **41 bits of millisecond timestamp**: the high bits, so IDs sort numerically in time order
- **10 bits of machine ID**: identifies which node generated the ID — 1,024 possible nodes
- **12 bits of sequence**: 4,096 IDs per millisecond per node before wrapping

Two messages sent at the exact same millisecond from different nodes differ in the machine ID field — deterministic ordering, no coordination, no network call. Generated entirely locally in nanoseconds. Twitter invented this. Discord uses it. We implement it from scratch.

---

### Problem 3: Who Is Online?

Before pushing a message to anyone, you need to know who is actually connected. Pushing to offline users wastes resources and fails silently.

The naive approach: store online status in PostgreSQL. User connects → `UPDATE users SET online = true`. User disconnects → `UPDATE users SET online = false`. This creates enormous write traffic just from users opening and closing their laptops. And if a server crashes without a clean disconnect, the user is stuck as "online" forever.

The right approach: **Redis with TTL**. User connects → `SET presence:{userID} 1 EX 30`. The key expires automatically in 30 seconds. The client sends a heartbeat every 20 seconds to refresh the TTL. User disconnects cleanly → delete the key immediately. User disconnects unexpectedly (crash, network drop, closed laptop) → key expires naturally within 30 seconds. No cleanup required. No stuck state.

Checking whether 1,000 users in a channel are online is a Redis pipeline of 1,000 GET calls — under a millisecond. This is why Redis is the right tool for presence: it is fast, TTL handles cleanup automatically, and it handles unexpected disconnects for free.

---

### Problem 4: Fan-Out

This is the core distributed problem of any messaging system. It has a name: **fan-out**.

Fan-out means one event needs to be delivered to many recipients. One message is sent, and it "fans out" to every online member of that channel.

```
                    Message sent by User A
                           │
          ┌────────────────┼────────────────┐
          │                │                │
          ▼                ▼                ▼
    User B online    User C online    User D online
    (push now)       (push now)       (push now)
```

With 10 members this is trivial. With 50,000 members it is not. You cannot loop over 50,000 users synchronously inside the request handler — the sender's API call would time out waiting. Fan-out must be asynchronous.

But there is a subtler version of the problem: **the multi-node fan-out problem**.

You run three instances of your service for availability. User B's WebSocket connection is held open by Node 1. User C's WebSocket connection is held open by Node 2. User A sends a message and the request lands on Node 1.

Node 1 can push to User B directly — it holds that connection in memory. But Node 1 has no idea where User C's connection is. Node 2 holds it. How does Node 1 tell Node 2 to push to User C?

```
User A sends message → request lands on Node 1
                              │
                    ┌─────────┴──────────┐
                    │                    │
                    ▼                    ▼
             User B connected      User C connected
               to Node 1             to Node 2
             (Node 1 can push)    (Node 1 CANNOT push)
                                        │
                              How does this message
                              reach Node 2?
```

You cannot have Node 1 call Node 2 directly — that creates a mesh where every node must know about and stay connected to every other node. With 10 nodes that is 90 connections to manage. With 100 nodes it is 9,900. It does not scale and it is a maintenance nightmare.

The solution is a **message bus**: a central broker that all nodes publish to and subscribe from. Node 1 writes the message to the bus. Every node that has members of that channel connected receives it from the bus and pushes to their local connections. Nodes never talk to each other directly.

We use **Kafka** as this bus. More on why in the technology section.

---

### Problem 5: Fan-In

Fan-out is one event going to many recipients. **Fan-in** is the reverse: many sources, one destination.

In our system, fan-in appears at the WebSocket gateway. Thousands of clients are simultaneously sending messages, typing indicators, and heartbeats — all flowing in through different connections into the same service process. The service must process all of them concurrently without any one client blocking another.

```
Client A ──────────────────────────────┐
Client B ──────────────────────────┐   │
Client C ────────────────────┐     │   │
Client D ────────────────┐   │     │   │
...                      ▼   ▼     ▼   ▼
                     ┌──────────────────────┐
                     │   WebSocket Gateway  │
                     │   (process all       │
                     │    concurrently)     │
                     └──────────────────────┘
```

Fan-in is why the gateway is a hard concurrency problem. Each open WebSocket needs a goroutine to read from it. 10,000 connections means 10,000 goroutines reading concurrently. Those reads must all be processed, validated, and acted on without any one of them blocking the others.

This is specifically why the WebSocket gateway is written in Go and not Node.js. Go's goroutine scheduler runs 10,000 goroutines on a handful of OS threads with negligible overhead. Node.js runs on a single thread — a CPU spike blocks every connection on that node simultaneously. For fan-in at scale, Go's concurrency model is structurally the right fit.

---

### Problem 6: Durability

When we tell a user "your message was sent," we must mean it. If our server crashes one millisecond after sending that confirmation, the message must still exist.

This means the message must be written to disk and confirmed by a majority of storage replicas before we respond to the sender. Not buffered in memory. Not written to one node that might crash. Written and confirmed by a quorum.

This is the same guarantee a WAL provides — write first, acknowledge after. The same principle applies here at the database level: Cassandra QUORUM writes require a majority of replicas to confirm before the write returns. A single node crash cannot lose a quorum-written message.

---

## The Full Data Flow

Now that the problems are clear, here is the complete flow of a message through the system — end to end, nothing hidden.

### Sending a Message

```
1.  Client sends:
    POST /api/v1/channels/{channelID}/messages
    Authorization: Bearer {jwt}
    Body: { "content": "hello" }

2.  Envoy routes to one of the Fastify nodes

3.  Fastify auth middleware validates the JWT
    → Extracts userID from token claims
    → Checks token blacklist in Redis (logged-out tokens)

4.  Fastify checks: is this user a member of this channel's server?
    → Query PostgreSQL (result cached in Redis)
    → If not a member: 403 Forbidden

5.  Fastify checks rate limit: too many messages recently?
    → Sliding window check in Redis
    → If exceeded: 429 Too Many Requests

6.  Fastify generates a Snowflake ID for the message
    → Local operation, no network call, ~100ns

7.  Fastify writes the message to Cassandra
    → Partition key: (channelID, currentTimeBucket)
    → Consistency level: QUORUM (majority of replicas must confirm)

8.  Fastify publishes a fan-out event to Kafka
    → Topic: "messages"
    → Partition key: channelID (all messages for a channel stay ordered)
    → Payload: serialized message

9.  Fastify returns 201 Created to the client
    → Message is now durable — Cassandra has it on a majority of replicas

10. (Asynchronous — happens in parallel across all gateway nodes)
    Kafka delivers the event to Go gateway consumer groups
    → Each gateway node receives the event
    → Each node checks its local connection registry:
       which members of this channel are connected to ME right now?
    → Pushes the message to each of those WebSocket connections
```

Step 9 is the key moment. The client receives confirmation after Cassandra confirms durability — not after fan-out completes. The fan-out in step 10 is asynchronous and best-effort. If a gateway node crashes between receiving the Kafka message and pushing it, those users miss the push. But the message is already in Cassandra, and their clients fetch it on reconnect or scroll. The durability guarantee is never violated.

---

### Receiving Messages in Real Time (WebSocket)

```
1.  Client opens WebSocket:
    WS /api/v1/gateway
    Authorization: Bearer {jwt}

2.  Go gateway validates the JWT
    → gRPC call to Fastify auth service
    → Fastify validates token and returns userID

3.  Go gateway registers the connection in its local registry:
    registry[userID] = wsConnection

4.  Client sends heartbeat every 20 seconds:
    → Go gateway refreshes presence in Redis:
       SET presence:{userID} 1 EX 30
    → Sends heartbeat_ack back to client

5.  When a Kafka message arrives for a channel this user belongs to:
    → Go gateway looks up userID in local registry
    → Pushes message over the WebSocket connection

6.  Client disconnects:
    → Go gateway removes connection from registry
    → Presence key expires in Redis within 30 seconds
```

---

### Fetching Message History

```
1.  Client sends:
    GET /api/v1/channels/{channelID}/messages?before={messageID}&limit=50

2.  Fastify validates auth and membership

3.  Fastify extracts the time bucket from the Snowflake cursor ID
    → Snowflake encodes the timestamp → compute bucket from it

4.  Fastify queries Cassandra:
    SELECT * FROM messages
    WHERE channel_id = ? AND bucket = ?
      AND message_id < ?
    ORDER BY message_id DESC
    LIMIT 50

5.  If fewer than 50 results (cursor near a bucket boundary):
    → Query the previous bucket, merge results, return 50

6.  Return messages to client
```

This is cursor-based pagination. The `before` parameter is a Snowflake ID — the oldest message the client currently has. We return the 50 messages before it. Each response implicitly gives the client its next cursor. This is O(1) per page regardless of depth.

Offset-based pagination (`?page=5&limit=50`) requires scanning and skipping rows. It gets slower the deeper you go. It is wrong for this use case and should not be used for message history at any scale.

---

## The Architecture

```
┌──────────────────────────────────────────────────────────────┐
│                         Clients                              │
│            REST API calls + WebSocket connections            │
└─────────────────────────┬────────────────────────────────────┘
                          │
                          ▼
┌──────────────────────────────────────────────────────────────┐
│                         Envoy                                │
│   Load balancing · TLS termination · Routing · Tracing       │
│   Sticky sessions for WebSocket (same client → same node)    │
└──────┬──────────────────────────────────────┬────────────────┘
       │                                      │
       ▼                                      ▼
┌──────────────────┐                 ┌────────────────────┐
│  Fastify Cluster │                 │  Go Gateway Cluster│
│  (REST API)      │◄────── gRPC ───►│  (WebSocket)       │
│                  │                 │                    │
│  Auth            │                 │  Connection mgmt   │
│  Servers/Channels│                 │  Fan-out           │
│  Messages (HTTP) │                 │  Presence updates  │
│  Rate limiting   │                 │  Heartbeats        │
└────────┬─────────┘                 └──────────┬─────────┘
         │                                      │
         │           ┌──────────────────────────┘
         ▼           ▼
┌──────────────────────────────────────────────────────────────┐
│                          Kafka                               │
│      Fan-out bus · Topic: messages · Partitioned by          │
│      channelID · Consumed by Go gateway cluster              │
└────────────────────┬─────────────────────────────────────────┘
         │           │                    │
         ▼           ▼                    ▼
┌─────────────┐  ┌───────────────┐  ┌──────────────┐
│  PostgreSQL │  │   Cassandra   │  │    Redis     │
│             │  │               │  │              │
│  users      │  │  messages     │  │  presence    │
│  servers    │  │  (partitioned │  │  rate limits │
│  channels   │  │   by channel  │  │  token       │
│  members    │  │   + bucket)   │  │  blacklist   │
│  roles      │  │               │  │              │
└─────────────┘  └───────────────┘  └──────────────┘
```

---

## Why Each Technology

### Fastify (Node.js) — REST API

The REST API layer handles authentication, CRUD operations, and business logic. This is almost entirely I/O-bound work — database queries, Redis lookups, validation. Node.js handles I/O-bound concurrency well via its event loop, and Fastify is the fastest Node.js framework by a significant margin with schema-based request validation built in.

This is also your primary language. For the business logic layer — where you want to move fast and reason clearly — using the language you know best is the right call. The REST API is not where the hard concurrency problems live.

### Go — WebSocket Gateway

The gateway holds thousands of open WebSocket connections simultaneously. Each connection needs a goroutine to read from it (fan-in). Fan-out means one Kafka message might need to push to hundreds of goroutines simultaneously. This is concurrency-heavy, CPU-involved work.

Node.js runs on a single thread. A CPU spike — even briefly — blocks every connection on that node simultaneously. Go's goroutine scheduler runs tens of thousands of goroutines on a handful of OS threads with negligible overhead. The fan-out loop, the connection registry, the presence updates — all of this happens concurrently in Go with no thread contention. The concurrency model matches the problem shape. This is why the split exists.

### Envoy — Load Balancer

Envoy is what Lyft, Airbnb, and most serious companies run as their edge proxy. Over nginx it gives you: gRPC-aware load balancing (it understands HTTP/2 streams, not just TCP connections), built-in Prometheus metrics for every route and upstream, OpenTelemetry tracing integration out of the box, and dynamic configuration via xDS (change routing rules without restarting). For WebSocket connections, Envoy handles sticky sessions — the same client always routes to the same gateway node, which is required because WebSocket connections are stateful in-memory objects.

### PostgreSQL — Relational Data

Users, servers, channels, memberships, and roles are relational. They have foreign keys. They need transactions. A user joining a server involves two writes — a membership record and a server member count increment — that must both succeed or both fail. PostgreSQL handles this correctly. The access pattern is also read-heavy with stable query shapes, which benefit from B-tree indexes and PostgreSQL's query planner. This is what PostgreSQL is built for.

### Cassandra — Messages

Messages have a fundamentally different profile from relational data:

- **Append-only**: you write once, never update the row (edits are a new record with a reference)
- **Time-ordered reads**: always "give me the last N messages in channel X"
- **Write-heavy**: a busy channel writes hundreds of rows per minute continuously
- **Must scale beyond one node**: no single server holds all messages for all channels forever

Cassandra is built for exactly this. Its data model forces you to design around access patterns — you choose a partition key (your shard key) and a clustering key (sort order within the partition). Messages sorted by time within a channel are a first-class modeling concept. Discord ran Cassandra for years. They migrated to ScyllaDB (same data model, implemented in C++) for better performance at their scale — not because the model was wrong.

PostgreSQL fails at this workload: MVCC creates dead tuples on constant appends, the process-per-connection model limits horizontal write throughput, and B-tree indexes are expensive to maintain on time-series data. These are PostgreSQL's architectural choices — correct for transactional workloads, wrong for this one.

### Kafka — Fan-Out Bus

When a message is saved, the Fastify node needs to notify all Go gateway nodes so they can push to their local connections. Two candidates:

**Redis Pub/Sub**: publish to a Redis channel, subscribers receive it. Simple. But fire-and-forget — if a Go gateway node is restarting when the publish happens, it misses the message permanently. Users on that node miss the delivery with no way to recover it from the bus.

**Kafka**: a distributed log. Messages are written to disk on the broker. Consumers track their position in the log (their offset). A gateway node restarts, reconnects to Kafka, and resumes from where it left off — it receives every message it missed during the restart and delivers them to its now-reconnected clients. Nothing is silently lost at the fan-out layer.

Kafka also preserves ordering. We partition the "messages" topic by `channelID`. All messages for channel X go to the same Kafka partition, in the exact order they were produced. Gateway nodes consuming that partition see messages for channel X in order. This is the real-time ordering guarantee — not just storage ordering.

The tradeoff is operational complexity. Kafka requires more setup than Redis Pub/Sub. It is worth it because the alternative is a fan-out layer with a silent delivery failure mode that is hard to detect and impossible to fix retroactively.

### Redis — Ephemeral State

Three distinct jobs, all requiring speed and none requiring durability:

**Presence**: online/offline status changes continuously. Redis TTL handles unexpected disconnects automatically — no cleanup code, no stuck state, no background jobs.

**Rate limiting**: distributed sliding window using Redis sorted sets. All Fastify nodes share the same Redis state, so a user cannot bypass rate limits by having requests land on different nodes.

**Token blacklist**: logouts add the token's JWT ID to a Redis set with TTL equal to the token's remaining lifetime. Memory usage is bounded automatically. Auth middleware checks this set on every request.

### gRPC — Internal Communication

Fastify and the Go gateway need to talk to each other. Two cases: the gateway needs to validate JWTs (calls Fastify's auth service rather than duplicating auth logic in Go), and Fastify occasionally needs to instruct the gateway directly (force-close connections on account ban, for example).

REST over HTTP/1.1 between internal services is wasteful on a hot path — no multiplexing, JSON parsing overhead on every call. gRPC uses HTTP/2 (multiplexed, binary framing) and Protocol Buffers (compact, typed, schema-enforced). The service contract is defined in a `.proto` file — a single source of truth that generates client and server code in both Node.js and Go. No drift between what Fastify sends and what Go expects.

---

## The Message Schema in Cassandra

```sql
CREATE KEYSPACE messaging
  WITH replication = {
    'class': 'NetworkTopologyStrategy',
    'datacenter1': 3    -- 3 replicas in this datacenter
  };

CREATE TABLE messaging.messages (
  channel_id   UUID,
  bucket       INT,        -- months since epoch: (year * 12 + month)
  message_id   BIGINT,     -- Snowflake ID: encodes time + machine + sequence
  user_id      UUID,
  content      TEXT,
  edited_at    TIMESTAMP,  -- null if never edited
  deleted      BOOLEAN,
  PRIMARY KEY ((channel_id, bucket), message_id)
) WITH CLUSTERING ORDER BY (message_id DESC);
```

**`(channel_id, bucket)` is the partition key** — this is the shard key. All messages for channel X in month Y live on the same Cassandra node, stored sorted by `message_id` descending. Fetching the last 50 messages in a channel is a single partition read: one node, no coordination, reads sequentially off disk in order.

**`bucket` prevents unbounded partition growth.** Without it, a channel active for five years accumulates millions of messages in one partition. Cassandra partitions have a practical size ceiling of a few hundred megabytes before performance degrades. Bucketing by month caps partition size. New partitions are created automatically as months pass.

**`message_id` is a Snowflake ID, not a UUID.** It sorts numerically in time order. `CLUSTERING ORDER BY (message_id DESC)` means the most recent messages are physically stored first in the partition — the read path for "last 50 messages" reads them sequentially off disk without skipping or scanning.

---

## The Auth System

JWT-based with refresh token rotation. We implement it from scratch because understanding auth is non-negotiable for a backend engineer.

**Access token**: 15-minute lifetime, stateless. Validated by checking the signature and expiry claim — no database call on the hot path. This is why JWTs exist.

**Refresh token**: 7-day lifetime, stored in PostgreSQL and delivered in an `httpOnly Secure` cookie — not localStorage, which is readable by XSS. Used only to obtain a new access token. On use, the old token is deleted and a new one is issued. This is rotation: a stolen refresh token can only be used once before the legitimate client's next refresh invalidates it. At that point both parties get errors and the user re-authenticates.

**Blacklisting**: logout adds the token's `jti` (JWT ID) to a Redis set with TTL equal to the token's remaining lifetime. Auth middleware checks this set. Memory usage is automatically bounded by the TTL.

**Rate limiting on auth endpoints**: 5 attempts per minute per IP using the Redis sliding window. Prevents brute force without any external dependency.

---

## The API Contract

REST for all resource operations. WebSocket for real-time delivery. Clients never use gRPC — that is an internal contract between services only.

```
Authentication
  POST   /api/v1/auth/register
  POST   /api/v1/auth/login
  POST   /api/v1/auth/refresh
  POST   /api/v1/auth/logout

Servers
  POST   /api/v1/servers
  GET    /api/v1/servers/:serverID
  PUT    /api/v1/servers/:serverID
  DELETE /api/v1/servers/:serverID

Channels
  POST   /api/v1/servers/:serverID/channels
  GET    /api/v1/servers/:serverID/channels
  PUT    /api/v1/servers/:serverID/channels/:channelID
  DELETE /api/v1/servers/:serverID/channels/:channelID

Messages
  POST   /api/v1/channels/:channelID/messages
  GET    /api/v1/channels/:channelID/messages   (?before=&limit=)

Membership
  POST   /api/v1/servers/:serverID/invites
  POST   /api/v1/invites/:code/accept
  DELETE /api/v1/servers/:serverID/members/:userID

WebSocket Gateway
  WS     /api/v1/gateway
```

Every response uses a consistent envelope:

```json
{
  "data": { "id": "...", "content": "hello" },
  "error": null
}
```

```json
{
  "data": null,
  "error": {
    "code": "CHANNEL_NOT_FOUND",
    "message": "The requested channel does not exist",
    "request_id": "01HV2X9KPQR4ESTJ"
  }
}
```

`request_id` is a Snowflake ID generated at the start of every request, attached to all log lines for that request across every service. When something breaks in production, you search logs by `request_id` and see the entire lifecycle — from Envoy ingress through Fastify through Cassandra through Kafka through the gateway. This is the minimum viable observability for a distributed system. Without it, debugging is archaeology.

---

## Consistency Tradeoffs

Every consistency decision in this system is explicit, not accidental.

**Strong consistency — where we need it:**

- **Message durability**: Cassandra QUORUM writes — a majority of replicas must confirm before we respond to the sender. One node crashing cannot lose a confirmed message.
- **Membership checks**: PostgreSQL with transactions. Whether a user can send a message cannot be stale.
- **Auth**: token blacklist checked synchronously on every request. A logged-out user cannot slip through on a cached auth result.

**Eventual consistency — where we accept it:**

- **Presence**: a user who closes their laptop without a clean disconnect appears online for up to 30 seconds. Showing someone as online for 30 extra seconds causes no real harm.
- **WebSocket delivery**: the push is asynchronous and best-effort. If a gateway node crashes after consuming a Kafka message but before pushing it, the affected users miss the push notification. They see the message when they scroll — it is already in Cassandra. The message is never lost, only the real-time notification is missed.
- **Member counts on servers**: cached in Redis, updated asynchronously. A server showing 1,003 members when there are 1,000 is fine.

The rule: **eventual consistency is acceptable for display state. It is not acceptable for anything that gates access or determines what data exists.**

---

## The DevOps Layer

**Local development**: Docker Compose brings up the full stack with one command — Fastify, Go gateway, Envoy, PostgreSQL, Cassandra, Redis, Kafka. No manual setup.

**AWS production:**

- **ECS (Fargate)**: managed containers for both Fastify and Go gateway — no EC2 instance management
- **RDS (PostgreSQL)**: managed, automatic backups, point-in-time recovery, automatic failover
- **ElastiCache (Redis)**: managed Redis cluster
- **MSK (Managed Kafka)**: managed Kafka — no broker management overhead
- **Amazon Keyspaces or self-managed Cassandra on EC2**: Keyspaces for operational simplicity, EC2 for cost at scale
- **ALB**: sticky sessions for WebSocket, routes REST to Fastify and WebSocket connections to Go gateway
- **ECR**: Docker image registry

**CI/CD (GitHub Actions):**

```
Push to main branch
  → Run tests (Fastify: jest, Go: go test ./...)
  → Build Docker images for both services
  → Push to ECR
  → Rolling deploy to ECS (zero downtime)
  → Smoke tests against production endpoints
```

**Observability:**

- **OpenTelemetry**: distributed traces that span Envoy → Fastify → Cassandra and Envoy → Go gateway → Kafka. One trace ID follows a request across every service boundary.
- **Prometheus**: request rate, p99 latency, error rate per endpoint, WebSocket connection count per gateway node, Kafka consumer lag
- **Grafana**: dashboards for the metrics that matter

The metric to watch most closely on the gateway: **Kafka consumer lag** — how far behind is the gateway from the Kafka head? If this number grows, messages are being produced faster than they are being consumed and delivered. This is your early warning for a fan-out bottleneck.

---

## What This Series Covers

Each post builds on the previous one. By the end, you have a system you understand completely.

1. **Production service structure** — Go and Fastify project layouts, configuration, structured logging, middleware chains, error handling patterns
2. **Auth system** — JWT from scratch, refresh token rotation, bcrypt, Redis blacklisting, rate limiting on auth endpoints
3. **PostgreSQL layer** — schema design, migrations, connection pooling with pgx and pg, indexing strategy, transactions
4. **Cassandra data modeling** — keyspace design, partition key strategy, time bucketing, QUORUM consistency, read and write paths
5. **Snowflake ID generator** — implementing it in Go from scratch, exposing it to Fastify via gRPC
6. **REST API** — servers, channels, memberships, cursor-based pagination, consistent error handling
7. **WebSocket gateway** — connection management in Go, heartbeat system, connection registry, fan-in handling
8. **Kafka integration** — producer in Fastify, consumer in Go gateway, partition strategy, consumer groups
9. **Fan-out system** — end to end: Fastify writes → Kafka delivers → Go gateway pushes → client receives
10. **Distributed rate limiting** — sliding window in Redis, per-user and per-endpoint limits shared across all Fastify nodes
11. **Idempotency** — duplicate message detection, safe retries on the message send endpoint
12. **DevOps** — Dockerfiles, Docker Compose for local dev, GitHub Actions CI/CD, AWS deployment, OpenTelemetry + Prometheus + Grafana

---

## What This System Does Not Cover

Honest scope:

- **No voice or video**: real-time media requires WebRTC and media servers — a separate system entirely
- **No end-to-end encryption**: key management is a significant domain of its own
- **No mobile push notifications**: APNs/FCM delivery for offline users is out of scope
- **No full-text message search**: searching history requires a separate search index like Elasticsearch
- **No file attachments**: S3 integration, CDN, and media processing are not covered

These are excluded because each would require a series of their own and would dilute the focus on the distributed systems core — which is what this series is actually about.

---

## Before You Read the Next Post

You should be able to answer these without looking anything up:

- Why do we shard messages by `(channelID, timeBucket)` and not just `channelID`?
- What is fan-out? What is the multi-node fan-out problem specifically, and how does Kafka solve it?
- What is fan-in, and why does it make the gateway a hard concurrency problem?
- Why does Kafka preserve message ordering within a channel in a way that Redis Pub/Sub cannot?
- What happens to a message if a Cassandra node crashes immediately after a QUORUM write returns success?
- Why does presence use Redis TTL instead of a database column?
- What does a Snowflake ID encode, and why does it sort by time without any coordination between nodes?
- Why is the Go gateway written in Go while the REST API is written in Node.js?
- What is cursor-based pagination and why is offset-based pagination wrong for message history?

If any of these are unclear, re-read the relevant section. The implementation posts assume this foundation.

Next post: **Production Go and Fastify Service Structure** — project layout, configuration management, structured logging, and the middleware chain every request passes through.
