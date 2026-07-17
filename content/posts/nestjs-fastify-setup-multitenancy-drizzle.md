---
title: "NestJS + Fastify: Production Project Setup with Multi-Tenancy and Drizzle ORM"
date: "2026-7-19"
readTime: "30 min read"
category: "System Design"
---

## A Note Before We Start

This is the second article in a series. The first covered Fastify from scratch — its architecture, plugin system, lifecycle hooks, and when to use it. If you haven't read it, the short summary: Fastify is a production Node.js framework that replaces Express, and NestJS + Fastify adapter gives you NestJS's architecture with Fastify's performance.

This article covers everything you need to build a production-ready project skeleton with NestJS and Fastify. We'll set up the entire foundation for a Multi-Tenant Wallet & Payments API — the real project starts in the next article.

You'll learn:
- What multi-tenancy is, why it exists, and the three types companies use
- Drizzle ORM vs Prisma (honest tradeoffs)
- How real companies structure NestJS projects (not the demo todo-app structure)
- Repository pattern, dependency injection, and why we separate layers
- Docker Compose for Postgres, Drizzle migrations, environment config
- Tenant resolution, JWT auth, and NestJS guards

By the end, you'll have a production-quality project template you can reuse for any SaaS backend. The next article adds wallets, optimistic locking, and idempotency.

---

## Part 1: Multi-Tenancy — What It Is and Why It Exists

### The Problem

Imagine you're building an invoicing SaaS. You sign your first customer — Acme Corp. They create invoices, send them, get paid. Your database has an `invoices` table. Everything works.

Then you sign a second customer — Globex Inc. Their invoices go into the same `invoices` table. Now every query needs to know: "is this invoice for Acme or Globex?" If you forget to filter, Globex sees Acme's invoices. That's a data leak — a production incident that erodes trust.

This is the core problem multi-tenancy solves: **how do you isolate each customer's data while running a single application?**

### The Three Approaches

There are three ways to solve this, and each has real tradeoffs.

**Approach 1: Database per Tenant**

Each customer gets their own PostgreSQL database.

```
docker-compose.yml
├── postgres-acme    (port 5432)
├── postgres-globex  (port 5433)
└── postgres-initech (port 5434)
```

| Pros | Cons |
|---|---|
| Maximum data isolation. One tenant can't impact another's performance | Expensive. Each database needs connections, backups, maintenance |
| Restoring one tenant's data is trivial (restore one DB) | Running migrations across 100+ databases is a nightmare |
| No risk of accidentally querying another tenant's data | Connection pool multiplies per tenant |

**Who uses it:** Shopify used this in their early days. Each store was a separate Ruby on Rails instance with its own MySQL database. They moved away from it because managing thousands of databases became unsustainable.

**When to choose:** Financial compliance (PCI-DSS, SOC2), when tenants have strict isolation requirements, when you have < 50 large enterprise customers willing to pay premium.

**Approach 2: Schema per Tenant (Postgres only)**

One database, but each tenant gets their own Postgres schema.

```sql
CREATE SCHEMA acme;
CREATE SCHEMA globex;
CREATE TABLE acme.invoices (...);
CREATE TABLE globex.invoices (...);
```

| Pros | Cons |
|---|---|
| Good isolation — each schema is a namespace | Complex migrations — you must run DDL against every schema |
| Shared connection pool (1 pool, not N) | Connection pool size must accommodate all tenants |
| Easier to manage than separate databases | Postgres-specific (MySQL doesn't have schemas the same way) |

**Who uses it:** Some enterprise SaaS platforms, especially in regulated industries. Citus (distributed Postgres) uses this model.

**When to choose:** You need strong isolation but can't afford separate databases per tenant. You're on Postgres.

**Approach 3: Shared Table (Row-Level)**

All tenants share the same tables. Every row has a `tenant_id` column. Every query filters by `WHERE tenant_id = ?`.

```
invoices table:
┌────────┬───────────┬──────────┬────────┐
│ id     │ tenant_id │ amount   │ status │
├────────┼───────────┼──────────┼────────┤
│ 1      │ acme      │ 100.00  │ paid   │
│ 2      │ acme      │ 200.00  │ sent   │
│ 3      │ globex    │ 500.00  │ paid   │
│ 4      │ globex    │ 150.00  │ draft  │
└────────┴───────────┴──────────┴────────┘

Query: SELECT * FROM invoices WHERE tenant_id = 'acme';
→ Returns rows 1 and 2. Globex data never leaks.
```

| Pros | Cons |
|---|---|
| Simplest infrastructure — one database, one pool, one migration | Every query MUST include tenant_id. One missing WHERE clause = data leak |
| Cheapest — lowest operational cost | Row count grows faster (all tenants in one table) — needs indexing discipline |
| Easiest to scale horizontally | Noisy neighbor problem (one tenant's heavy queries affect others) |

**Who uses it:** Slack, Notion, GitHub, Stripe, most modern SaaS. Slack stores all customers in shared tables with a `team_id` column.

**When to choose:** You're building a modern SaaS, you have automated guardrails (tenant middleware, RLS), and you accept that data leaks must be prevented at the application level.

### What We'll Use

We'll use **row-level multi-tenancy** with `tenant_id` on every table. This is what most modern SaaS companies use, and it's the simplest to set up. The entire series builds on this — every service, every repository, every query includes `tenant_id`.

The key rule: **tenant_id must be set automatically by infrastructure, never manually by the developer.** We'll use a NestJS guard + decorator + tenant service to inject tenant_id into every request. If a developer forgets to filter by tenant_id, the guard-based approach at least ensures the tenant context exists — but it can't save you from a raw SQL query that omits the filter. That discipline comes from the Repository pattern (covered in Part 4).

---

## Part 2: Drizzle ORM

### What Is Drizzle

Drizzle is a TypeScript ORM that takes a different approach from Prisma. Instead of a separate schema file and a code generator, Drizzle uses **code-first TypeScript definitions** to define your database schema.

```ts
// Drizzle: you write TypeScript, it generates SQL
import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
```

Prisma requires a separate `schema.prisma` file and runs `prisma generate` to produce TypeScript types. Drizzle has no code generation step — your schema file IS the source of truth and compiles directly to TypeScript types.

### Drizzle vs Prisma

| | Prisma | Drizzle |
|---|---|---|
| **Approach** | Schema-first (`.prisma` file) | Code-first (TypeScript) |
| **Bundle size** | ~50MB (includes engine binary) | ~0KB (zero-dependency at runtime) |
| **Cold start** | 500ms+ (starts engine) | 0ms (no engine) |
| **Type safety** | Excellent (generated types) | Excellent (inferred types) |
| **Relations** | `include: { posts: true }` magic | Explicit joins |
| **Migrations** | `prisma migrate` (handles well) | `drizzle-kit` (manual-friendly) |
| **Raw SQL** | `$queryRaw` (string) | `sql\`...\`` (tagged template, type-safe) |
| **Edge/FaaS** | Heavy (engine binary) | Perfect (no deps) |
| **Developer UX** | Magical, "it just works" | Require you to understand SQL |

**Why Drizzle over Prisma for this project:**

1. **No engine.** Prisma ships a Rust binary (~50MB) that runs alongside your app. It handles query generation and connection management. On serverless (Lambda, Workers), this binary makes cold starts painful. Drizzle has zero runtime dependencies — it generates SQL strings at build time and uses the native `pg` or `postgres.js` driver at runtime.

2. **Explicit SQL.** Prisma's `include` and `where` abstractions hide SQL behind magic strings. When a query is slow, you have to figure out what SQL Prisma generated. Drizzle queries look like SQL — you understand exactly what the database will execute.

3. **Migrations.** Prisma migrations are automatic but opaque. If a migration fails halfway, you're in a state that's hard to recover from. Drizzle migrations are plain SQL files that you can review, modify, and run manually.

4. **Edge compatibility.** Our wallet API might eventually run on edge functions. Prisma can't run there. Drizzle can.

**The tradeoff you need to accept:** Drizzle requires you to know SQL. Prisma lets you avoid SQL. If you're comfortable with `SELECT`, `JOIN`, `WHERE`, and `GROUP BY`, Drizzle is more productive because you're writing what you understand. If you prefer ORM magic, stay with Prisma.

### Drizzle Schema, Migrations, and Queries

We'll use Drizzle with `postgres.js` (a fast, lightweight Postgres driver) and `drizzle-kit` for migrations:

```ts
// drizzle.config.ts — tells drizzle-kit where to find schemas
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/**/*.schema.ts",
  out: "./src/drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

Commands:

```bash
npx drizzle-kit generate    # Generate SQL migration from schema changes
npx drizzle-kit migrate     # Run pending migrations
npx drizzle-kit push        # Push schema directly (dev only — like prisma db push)
npx drizzle-kit studio      # GUI database browser
```

The `generate` command compares your TypeScript schemas against the current state in `drizzle.config.ts` and produces SQL migration files you can review and commit.

---

## Part 3: Project Architecture

### How Companies Actually Structure NestJS Projects

The NestJS documentation shows a todo-app structure where everything is in `src/` with one module. Real production codebases look different. Here's what a typical SaaS backend looks like after 6+ months of development:

```
src/
├── main.ts                      # Entry point, FastifyAdapter bootstrap
├── app.module.ts                # Root module — imports everything
├── config/                      # Per-domain config files (registerAs)
│   ├── database.config.ts
│   └── jwt.config.ts
├── common/                      # Shared infrastructure (not business logic)
│   ├── database/
│   │   ├── database.module.ts
│   │   ├── database.service.ts
│   │   └── drizzle.schema.ts
│   ├── tenant/
│   │   ├── tenant.guard.ts      # Global request guard
│   │   ├── tenant.decorator.ts   # @Tenant() param decorator
│   │   └── tenant.module.ts     # Global module, provides guard + decorator
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.service.ts
│   │   ├── jwt.guard.ts
│   │   └── current-user.decorator.ts
│   └── common.module.ts
├── modules/                     # Business logic — one folder per domain
│   ├── tenants/
│   │   ├── tenants.module.ts
│   │   ├── tenants.service.ts   # Resolve + CRUD for tenants
│   │   ├── tenants.controller.ts
│   │   └── tenant.schema.ts     # Drizzle table definition
│   ├── wallets/
│   │   ├── wallets.module.ts
│   │   ├── wallets.controller.ts
│   │   ├── wallets.service.ts
│   │   ├── wallets.repository.ts
│   │   └── wallets.schema.ts
│   └── transactions/
│       ├── transactions.module.ts
│       ├── transactions.controller.ts
│       ├── transactions.service.ts
│       ├── transactions.repository.ts
│       └── transactions.schema.ts
└── drizzle/
    ├── migrations/
    └── drizzle.config.ts
```

**The two rules that define this structure:**

1. **Common vs Modules.** `common/` contains infrastructure that multiple modules use — database, auth, tenants, config. `modules/` contains business logic — wallets, transactions, users. A module in `modules/` can import from `common/`, but `common/` never imports from `modules/`.

2. **One folder per domain.** Every business domain (wallets, transactions, users) gets its own module folder with controller, service, repository, and schema files. Cross-domain communication happens through the NestJS dependency injection — `WalletsService` calls `TransactionsService`, not through shared database queries.

### The Repository Pattern

NestJS services often access the database directly. For simple CRUD, this is fine. For a wallet system where every database operation involves business rules, we separate concerns:

```
┌──────────┐     ┌──────────┐     ┌──────────────┐     ┌─────────┐
│ Controller │────▶│  Service  │────▶│  Repository   │────▶│ Drizzle │
│ (HTTP)    │     │ (Business)│     │   (Data)     │     │   ORM   │
└──────────┘     └──────────┘     └──────────────┘     └─────────┘
```

**Controller** — handles HTTP (params, body, response codes, headers). No business logic. No database calls.

```ts
@Controller("wallets")
export class WalletsController {
  constructor(private readonly walletsService: WalletsService) {}

  @Get(":id")
  async getWallet(@Param("id") id: string, @Tenant() tenant: TenantContext) {
    return this.walletsService.findById(tenant.id, id);
    // Controller: validates input, calls service, returns result
    // No database here.
  }
}
```

**Service** — contains business rules. Orchestrates repositories. Throws domain errors.

```ts
@Injectable()
export class WalletsService {
  constructor(
    private readonly walletsRepository: WalletsRepository,
    private readonly transactionsRepository: TransactionsRepository,
  ) {}

  async debit(tenantId: string, walletId: string, amount: number) {
    // Business logic: check balance, prevent negative, validate amount
    const wallet = await this.walletsRepository.findById(tenantId, walletId);
    if (!wallet) throw new NotFoundException("Wallet not found");
    if (wallet.balance < amount) throw new BadRequestException("Insufficient funds");

    // Delegates data work to repository
    return this.walletsRepository.updateBalance(tenantId, walletId, wallet.balance - amount);
  }
}
```

**Repository** — knows Drizzle. Maps data between database and application. Contains queries.

```ts
@Injectable()
export class WalletsRepository {
  constructor(private readonly db: DrizzleService) {}

  async findById(tenantId: string, id: string) {
    const result = await this.db.client
      .select()
      .from(wallets)
      .where(and(eq(wallets.tenantId, tenantId), eq(wallets.id, id)))
      .limit(1);
    return result[0] || null;
  }
}
```

**Why separate repository from service?**

- **Testability.** You can mock the repository when testing the service. You test business rules with fake data, not a real database.
- **Swappable database.** If you migrate from Postgres to something else, only the repository changes. The service doesn't know what database you use.
- **Query complexity stays in one place.** All SQL-related code lives in repositories. Services stay clean.

**The honest tradeoff:** For a project with 3-5 tables, repositories add boilerplate with little benefit. For a wallet system with 10+ tables, concurrency rules, and transactional logic, repositories save you from messy service files that mix business logic and SQL.

---

## Part 4: Project Setup

Let's build the project. Every command, every file, explained.

### 4.1 Initialize the Project

```bash
npm i -g @nestjs/cli
nest new wallet-api --package-manager pnpm
cd wallet-api
```

When prompted, choose `pnpm` as the package manager. Then add Fastify:

```bash
pnpm add @nestjs/platform-fastify @fastify/static
```

The `@nestjs/platform-fastify` package provides `FastifyAdapter` — the bridge between NestJS and Fastify. `@fastify/static` is needed by the NestJS Fastify adapter internally.

### 4.2 Install Drizzle

```bash
pnpm add drizzle-orm postgres
pnpm add -D drizzle-kit @types/node
```

- `drizzle-orm` — the ORM library
- `postgres` — the PostgreSQL driver (lightweight, fast, no deps)
- `drizzle-kit` — CLI for migrations and schema pushing
- `@types/node` — needed for `process.env` types

### 4.3 Environment Configuration

```bash
pnpm add @nestjs/config
```

NestJS config module loads `.env` into `process.env`. We use `registerAs()` to create typed, per-domain config namespaces that each module loads independently.

```ts
// src/config/database.config.ts
import { registerAs } from "@nestjs/config";

export default registerAs("database", () => {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  return { url };
});
```

```ts
// src/config/jwt.config.ts
import { registerAs } from "@nestjs/config";

export default registerAs("jwt", () => {
  const secret = process.env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("JWT_SECRET is required and must be at least 32 characters");
  }
  return {
    secret,
    expiration: process.env.JWT_EXPIRATION || "15m",
  };
});
```

Each file validates its own variables and throws at startup if something is missing. No central file knows about everything — if you remove the Auth module, `jwt.config.ts` is never loaded.

Each module uses `ConfigModule.forFeature()` to load only its namespace (shown in the database and auth sections below).

### 4.4 Docker Compose for Postgres

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: wallet_user
      POSTGRES_PASSWORD: wallet_pass
      POSTGRES_DB: wallet_db
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

Command:

```bash
docker compose up -d   # Start Postgres in background
```

### 4.5 Drizzle Setup

```ts
// drizzle.config.ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: "./src/**/*.schema.ts",
  out: "./src/drizzle/migrations",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
});
```

The `schema` glob `./src/**/*.schema.ts` tells drizzle-kit to find all files ending in `.schema.ts` anywhere in `src/`. Each module will have its own schema file — wallets have `wallets.schema.ts`, transactions have `transactions.schema.ts`, etc.

Add scripts to `package.json`:

```json
{
  "scripts": {
    "db:generate": "drizzle-kit generate",
    "db:migrate": "drizzle-kit migrate",
    "db:studio": "drizzle-kit studio"
  }
}
```

### 4.6 DrizzleService — Wrapping the Client

We create a NestJS provider that wraps the Drizzle client. This lets us inject `DrizzleService` into any repository without importing Drizzle directly.

```ts
// src/common/database/database.service.ts
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { ConfigType } from "@nestjs/config";
import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import databaseConfig from "../../config/database.config";
import * as schema from "./drizzle.schema";

@Injectable()
export class DrizzleService implements OnModuleInit, OnModuleDestroy {
  public db: NodePgDatabase<typeof schema>;
  private pool: Pool;

  constructor(
    @Inject(databaseConfig.KEY)
    private readonly dbConfig: ConfigType<typeof databaseConfig>,
  ) {}

  async onModuleInit() {
    this.pool = new Pool({
      connectionString: this.dbConfig.url,
    });
    this.db = drizzle(this.pool, { schema });
  }

  async onModuleDestroy() {
    await this.pool.end();
  }
}
```

The `drizzle.schema.ts` file re-exports all schemas from every module:

```ts
// src/common/database/drizzle.schema.ts
export * from "../../modules/tenants/tenant.schema";
export * from "../../modules/wallets/wallets.schema";
export * from "../../modules/transactions/transactions.schema";
// Each new module's schema gets added here
```

This single-import approach is the Drizzle recommended pattern. When you add a new module, you add one line to this file.

```ts
// src/common/database/database.module.ts
import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import databaseConfig from "../../config/database.config";
import { DrizzleService } from "./database.service";

@Global()
@Module({
  imports: [ConfigModule.forFeature(databaseConfig)],
  providers: [DrizzleService],
  exports: [DrizzleService],
})
export class DatabaseModule {}
```

`@Global()` makes `DrizzleService` available to all modules without importing `DatabaseModule` in each one. This is intentional — the database client is truly a cross-cutting concern that every repository needs.

### 4.7 Main.ts — NestJS + Fastify Adapter

```ts
// src/main.ts
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, NestFastifyApplication } from "@nestjs/platform-fastify";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter(),
  );

  app.enableCors({
    origin: ["http://localhost:3000"],
    credentials: true,
  });

  app.enableShutdownHooks();  // Listen for SIGTERM/SIGINT

  const port = process.env.PORT || 3000;
  await app.listen(port, "0.0.0.0");

  console.log(`Server running on http://localhost:${port}`);
  console.log(`Using Fastify under the hood`);
}

bootstrap();
```

The critical line: `NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter())`. This replaces the default Express adapter with Fastify. Every request from this point uses Fastify's radix-tree router, serialization, and Pino logger. The rest of your code doesn't know the difference — it just uses NestJS controllers, services, and guards as usual.

---

## Part 5: The Multi-Tenancy Module

Multi-tenancy touches two layers of the application. The **infrastructure** layer ensures every request has a tenant context (guard + decorator). The **business** layer provides tenant CRUD and resolution (service + schema + controller).

We keep the infrastructure in `common/tenant/` and the business logic in `modules/tenants/`.

### 5.1 Tenant Schema (modules/tenants/)

```ts
// src/modules/tenants/tenant.schema.ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),        // "acme-corp"
  name: text("name").notNull(),        // "Acme Corporation"
  slug: text("slug").notNull().unique(), // "acme"
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

Each tenant is a row. All other tables reference `tenant_id` as a foreign key. The schema lives in `modules/tenants/` because it defines a business entity, not infrastructure.

### 5.2 Tenant Service (modules/tenants/)

The service resolves tenants for the guard and provides CRUD for tenant management.

```ts
// src/modules/tenants/tenants.service.ts
import { Injectable, NotFoundException } from "@nestjs/common";
import { eq } from "drizzle-orm";
import { DrizzleService } from "../../common/database/database.service";
import { tenants } from "./tenant.schema";

export interface TenantContext {
  id: string;
  name: string;
  slug: string;
}

@Injectable()
export class TenantsService {
  constructor(private readonly drizzle: DrizzleService) {}

  async resolveBySlug(slug: string): Promise<TenantContext | null> {
    const result = await this.drizzle.db
      .select()
      .from(tenants)
      .where(eq(tenants.slug, slug))
      .limit(1);
    return result[0] || null;
  }

  async resolveByApiKey(apiKey: string): Promise<TenantContext | null> {
    const parts = apiKey.split(":");
    if (parts.length !== 2) return null;
    const [tenantId] = parts;
    const result = await this.drizzle.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, tenantId))
      .limit(1);
    return result[0] || null;
  }
}
```

### 5.3 Tenant Guard (common/tenant/)

The guard runs before every route. It extracts the tenant from the request headers and attaches it to the request context. If the tenant can't be resolved, it returns 401.

```ts
// src/common/tenant/tenant.guard.ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { TenantsService, TenantContext } from "../../modules/tenants/tenants.service";

declare module "fastify" {
  interface FastifyRequest {
    tenant: TenantContext;
  }
}

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly tenantsService: TenantsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    // Strategy 1: Header-based (X-Tenant-Slug)
    const slug = request.headers["x-tenant-slug"] as string;
    if (slug) {
      const tenant = await this.tenantsService.resolveBySlug(slug);
      if (tenant) { request.tenant = tenant; return true; }
    }

    // Strategy 2: API Key header
    const apiKey = request.headers["x-api-key"] as string;
    if (apiKey) {
      const tenant = await this.tenantsService.resolveByApiKey(apiKey);
      if (tenant) { request.tenant = tenant; return true; }
    }

    // Strategy 3: Subdomain (e.g., acme.api.myapp.com)
    const host = request.headers["host"] || "";
    const subdomain = host.split(".")[0];
    if (subdomain && subdomain !== "api") {
      const tenant = await this.tenantsService.resolveBySlug(subdomain);
      if (tenant) { request.tenant = tenant; return true; }
    }

    throw new UnauthorizedException("Tenant not found. Provide X-Tenant-Slug or X-Api-Key header.");
  }
}
```

Three resolution strategies, checked in order:
1. **Header-based** (`X-Tenant-Slug`) — easiest for API clients and curl
2. **API Key** (`X-Api-Key`) — standard for programmatic access
3. **Subdomain** — for browser-based apps

### 5.4 Tenant Decorator (common/tenant/)

Instead of reaching into `request.tenant` manually in every controller, we create a decorator:

```ts
// src/common/tenant/tenant.decorator.ts
import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { TenantContext } from "../../modules/tenants/tenants.service";

export const Tenant = createParamDecorator(
  (data: unknown, ctx: ExecutionContext): TenantContext => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    return request.tenant;
  },
);
```

Usage in a controller:

```ts
@Get("wallets")
async getAll(@Tenant() tenant: TenantContext) {
  return this.walletsService.findAll(tenant.id);
}
```

### 5.5 Infrastructure Module (common/tenant/)

Provides the guard and decorator globally. The guard's dependency on `TenantsService` is resolved by NestJS DI — when `TenantsModule` is imported in `AppModule`, the service becomes available to all injectors.

```ts
// src/common/tenant/tenant.module.ts
import { Global, Module } from "@nestjs/common";
import { TenantGuard } from "./tenant.guard";
import { Tenant } from "./tenant.decorator";

@Global()
@Module({
  providers: [TenantGuard, Tenant],
  exports: [TenantGuard, Tenant],
})
export class TenantInfraModule {}
```

### 5.6 Business Module (modules/tenants/)

```ts
// src/modules/tenants/tenants.module.ts
import { Module } from "@nestjs/common";
import { TenantsService } from "./tenants.service";

@Module({
  providers: [TenantsService],
  exports: [TenantsService],
})
export class TenantsModule {}
```

### Why the split?

The guard and decorator are **infrastructure** — they process every HTTP request, extract context, inject it into the handler. They live in `common/` because they're cross-cutting concerns used by every module.

The schema, service, and controller are **business logic** — they define what a tenant IS and how to manage them. They live in `modules/tenants/` because they're a domain like any other.

The guard imports `TenantsService` from the business module. This is an accepted exception to the "common never imports modules" rule — the guard needs domain knowledge to resolve who the tenant is. NestJS's DI makes this work regardless of where the service is defined.

---

## Part 6: Auth Module

### 6.1 Auth Service (JWT)

```ts
// src/common/auth/auth.service.ts
import { Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { ConfigType } from "@nestjs/config";
import { JwtService } from "@nestjs/jwt";
import jwtConfig from "../../config/jwt.config";

export interface JwtPayload {
  sub: string;      // User ID
  tenantId: string; // Tenant this user belongs to
  role: string;     // "admin" | "member"
}

@Injectable()
export class AuthService {
  constructor(
    private readonly jwtService: JwtService,
    @Inject(jwtConfig.KEY)
    private readonly config: ConfigType<typeof jwtConfig>,
  ) {
    // config.secret — typed, only JWT fields
    // config.expiration — typed, only JWT fields
  }

  async login(userId: string, tenantId: string, role: string): Promise<string> {
    const payload: JwtPayload = { sub: userId, tenantId, role };
    return this.jwtService.signAsync(payload);
  }

  async verify(token: string): Promise<JwtPayload> {
    try {
      return await this.jwtService.verifyAsync<JwtPayload>(token);
    } catch {
      throw new UnauthorizedException("Invalid or expired token");
    }
  }
}
```

### 6.2 JWT Guard

```ts
// src/common/auth/jwt.guard.ts
import { Injectable, CanActivate, ExecutionContext, UnauthorizedException } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { AuthService, JwtPayload } from "./auth.service";

declare module "fastify" {
  interface FastifyRequest {
    user: JwtPayload;
  }
}

@Injectable()
export class JwtGuard implements CanActivate {
  constructor(private readonly authService: AuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    const authHeader = request.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new UnauthorizedException("Missing or invalid Authorization header");
    }

    const token = authHeader.slice(7);
    const payload = await this.authService.verify(token);
    request.user = payload;

    return true;
  }
}
```

### 6.3 Current User Decorator

```ts
// src/common/auth/current-user.decorator.ts
import { createParamDecorator, ExecutionContext } from "@nestjs/common";
import { FastifyRequest } from "fastify";
import { JwtPayload } from "./auth.service";

export const CurrentUser = createParamDecorator(
  (data: keyof JwtPayload | undefined, ctx: ExecutionContext): JwtPayload | string => {
    const request = ctx.switchToHttp().getRequest<FastifyRequest>();
    const user = request.user;
    return data ? user[data] : user;
  },
);
```

Usage:

```ts
@Get("profile")
async getProfile(
  @Tenant() tenant: TenantContext,
  @CurrentUser("sub") userId: string,
) {
  // userId is extracted from the JWT automatically
}
```

### 6.4 Auth Module

```ts
// src/common/auth/auth.module.ts
import { Global, Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { JwtModule } from "@nestjs/jwt";
import jwtConfig from "../../config/jwt.config";
import { AuthService } from "./auth.service";
import { JwtGuard } from "./jwt.guard";

@Global()
@Module({
  imports: [
    ConfigModule.forFeature(jwtConfig),
    JwtModule.registerAsync({
      inject: [jwtConfig.KEY],
      useFactory: (config: { secret: string; expiration: string }) => ({
        secret: config.secret,
        signOptions: { expiresIn: config.expiration },
      }),
    }),
  ],
  providers: [AuthService, JwtGuard],
  exports: [AuthService, JwtGuard],
})
export class AuthModule {}
```

---

## Part 7: Health Module

A simple health endpoint used by load balancers and orchestration tools.

```ts
// src/modules/health/health.controller.ts
import { Controller, Get } from "@nestjs/common";
import { DrizzleService } from "../../common/database/database.service";

@Controller("health")
export class HealthController {
  constructor(private readonly drizzle: DrizzleService) {}

  @Get()
  async check() {
    // Check database connectivity
    try {
      await this.drizzle.db.execute("SELECT 1");
    } catch {
      return { status: "degraded", database: "unreachable" };
    }

    return {
      status: "healthy",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    };
  }
}
```

```ts
// src/modules/health/health.module.ts
import { Module } from "@nestjs/common";
import { HealthController } from "./health.controller";

@Module({
  controllers: [HealthController],
})
export class HealthModule {}
```

---

## Part 8: Wiring It Together

```ts
// src/app.module.ts
import { Module } from "@nestjs/common";
import { ConfigModule as NestConfigModule } from "@nestjs/config";
import { DatabaseModule } from "./common/database/database.module";
import { TenantInfraModule } from "./common/tenant/tenant.module";
import { TenantsModule } from "./modules/tenants/tenants.module";
import { AuthModule } from "./common/auth/auth.module";
import { HealthModule } from "./modules/health/health.module";
import { APP_GUARD } from "@nestjs/core";

@Module({
  imports: [
    NestConfigModule.forRoot({ isGlobal: true }),  // Loads .env — no validation here
    DatabaseModule,
    TenantInfraModule,
    TenantsModule,
    AuthModule,
    HealthModule,
  ],
  providers: [
    {
      provide: APP_GUARD,
      useClass: TenantGuard,  // From TenantInfraModule
    },
    {
      provide: APP_GUARD,
      useClass: JwtGuard,
    },
  ],
})
export class AppModule {}
```

The `APP_GUARD` provider applies the guard to every route in every module. This means **all routes require authentication and tenant context by default**. To make a route public, you create a `@Public()` decorator that sets metadata:

```ts
import { SetMetadata } from "@nestjs/common";
export const IS_PUBLIC_KEY = "isPublic";
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
```

Then in the guard, check for the metadata:

```ts
const isPublic = Reflect.getMetadata(IS_PUBLIC_KEY, context.getHandler());
if (isPublic) return true;  // Skip auth for public routes
```

---

## Part 9: The Database Schema — First Migration

Now we need our first actual database tables. Let's create the tenant schema and run the first migration.

```ts
// src/modules/tenants/tenant.schema.ts
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const tenants = pgTable("tenants", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});
```

Generate the migration:

```bash
npx drizzle-kit generate
```

This creates a file like `src/drizzle/migrations/0000_busy_tenants.sql`:

```sql
CREATE TABLE IF NOT EXISTS "tenants" (
  "id" text PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "tenants_slug_unique" ON "tenants" ("slug");
```

Run the migration:

```bash
npx drizzle-kit migrate
```

This creates a `__drizzle_migrations` table in the database and tracks which migrations have been applied. Future migrations run in order.

---

## Part 10: Testing the Setup

### 10.1 Environment File

```env
# .env
NODE_ENV=development
PORT=3000
DATABASE_URL=postgres://wallet_user:wallet_pass@localhost:5432/wallet_db
JWT_SECRET=your-super-secret-key-that-is-at-least-32-chars
JWT_EXPIRATION=15m
```

### 10.2 Quick Test

```bash
# Start Postgres
docker compose up -d

# Run migrations
npx drizzle-kit migrate

# Start the server
pnpm run start:dev

# In another terminal:
curl http://localhost:3000/health
# → 401 because you need tenant + auth

curl -H "X-Tenant-Slug: acme" -H "Authorization: Bearer test" http://localhost:3000/health
# → 401 because "test" is not a valid JWT
```

The 401 on the health check is expected — both guards are global. To fix this, mark the health check as public:

```ts
@Controller("health")
export class HealthController {
  @Get()
  @Public()  // <-- Add this decorator
  async check() { ... }
}
```

---

## Part 11: Comparing What We Built vs Real Companies

Here's how this architecture maps to what companies actually run:

| Company | NestJS | DB ORM | Multi-tenancy | Auth |
|---|---|---|---|---|
| **Your project** | ✅ NestJS + Fastify | ✅ Drizzle | ✅ Row-level (tenant_id) | ✅ JWT |
| **Typical startup (< 50 eng)** | ✅ NestJS | Prisma or Drizzle | Row-level | JWT + Passport |
| **Mid-size SaaS (50-200 eng)** | ✅ NestJS | TypeORM or MikroORM | Row-level + RLS policies | JWT + RBAC |
| **Enterprise (200+ eng)** | ✅ NestJS or custom | Custom DAO layer | Schema-per-tenant or DB-per-tenant | OAuth2 + SAML |

The NestJS community in production is dominated by the patterns shown here:
- `@Global()` modules for database, auth, and config
- `APP_GUARD` for cross-cutting security
- Feature modules organized by domain
- Guards + decorators for extracting request context

---

## Summary

What we built:

```
wallet-api/
├── docker-compose.yml          # PostgreSQL
├── drizzle.config.ts           # Drizzle kit config
├── .env                        # Environment variables
└── src/
    ├── main.ts                 # NestJS + FastifyAdapter
    ├── app.module.ts           # Root module with global guards
    ├── config/
    │   ├── database.config.ts  # DATABASE_URL validation
    │   └── jwt.config.ts       # JWT_SECRET validation
    ├── common/
    │   ├── database/
    │   │   ├── database.module.ts    # Global Drizzle client
    │   │   ├── database.service.ts   # Drizzle wrapper with Pool
    │   │   └── drizzle.schema.ts     # Re-exports all module schemas
    │   ├── tenant/
    │   │   ├── tenant.module.ts      # Global infrastructure module
    │   │   ├── tenant.guard.ts       # Resolves tenant from request
    │   │   └── tenant.decorator.ts   # @Tenant() param decorator
    │   └── auth/
    │       ├── auth.module.ts        # JWT auth infrastructure
    │       ├── auth.service.ts       # Sign + verify JWT
    │       ├── jwt.guard.ts          # Global auth guard
    │       └── current-user.decorator.ts  # @CurrentUser() param decorator
    └── modules/
        ├── tenants/
        │   ├── tenants.module.ts     # Tenant CRUD + resolution
        │   ├── tenants.service.ts
        │   ├── tenants.controller.ts
        │   └── tenant.schema.ts      # Drizzle table definition
        └── health/
            ├── health.module.ts
            └── health.controller.ts  # Database health check
```

The key patterns every production NestJS app follows:
1. **Global guards** for auth and tenant — no route is unprotected by default
2. **Repository pattern** separates data access from business logic
3. **Domain modules** keep wallets, transactions, and users in separate folders
4. **Custom decorators** extract request context so controllers stay clean

### What's Next

The next article builds the core wallet functionality on top of this foundation:
- Wallet table with optimistic locking (`version` column)
- Debit/credit operations with Drizzle transactions
- Idempotency keys (`idempotency_key` unique constraint)
- Balance read model vs transaction log
- Drizzle relations and joins across wallets and transactions

The architecture we set up today handles all of that without modification. The multi-tenancy guard ensures every wallet query is scoped to the right tenant. The JWT guard ensures only authenticated users can access the API. The repository pattern keeps business logic clean when we add complex transaction rules.
