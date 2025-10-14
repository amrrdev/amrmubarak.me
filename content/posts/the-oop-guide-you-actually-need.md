---
title: "The OOP Guide You Actually Need"
date: "2025-10-15"
readTime: "15 min read"
---

## Let's Build Something Real

We're going to build a user authentication system. Not because it's fancy, but because it's real. Every application needs it. You've probably built one before.

We'll start with the messy, procedural way most people write it. Then we'll see the problems. Then we'll fix them. By the end, you'll understand not just what OOP is, but why it exists and how to think in it.

## The First Attempt: Just Make It Work

You need to register users. They provide an email and password. You save them. Simple enough.

```typescript
function registerUser(email: string, password: string) {
  // Save to database
  await db.query("INSERT INTO users (email, password) VALUES (?, ?)", [email, password]);

  return { success: true };
}
```

Done. Ship it.

But wait. We're storing passwords in plain text. That's a security disaster. Let's fix it.

```typescript
function registerUser(email: string, password: string) {
  // Hash the password
  const hashedPassword = bcrypt.hash(password);

  await db.query("INSERT INTO users (email, password) VALUES (?, ?)", [email, hashedPassword]);

  return { success: true };
}
```

Better. But now someone can register with an invalid email like "notanemail" or an empty string. Let's add validation.

```typescript
function registerUser(email: string, password: string) {
  // Validate email
  if (!email || !email.includes("@") || !email.includes(".")) {
    throw new Error("Invalid email format");
  }

  // Validate password
  if (!password || password.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  // Hash the password
  const hashedPassword = bcrypt.hash(password);

  await db.query("INSERT INTO users (email, password) VALUES (?, ?)", [email, hashedPassword]);

  return { success: true };
}
```

Good. Now we need login functionality.

```typescript
function loginUser(email: string, password: string) {
  // Get user from database
  const result = await db.query("SELECT * FROM users WHERE email = ?", [email]);

  if (result.length === 0) {
    throw new Error("Invalid credentials");
  }

  const user = result[0];

  // Check password
  const isValid = bcrypt.compare(password, user.password);

  if (!isValid) {
    throw new Error("Invalid credentials");
  }

  // Generate token
  const token = jwt.sign({ userId: user.id }, SECRET_KEY);

  return { token };
}
```

Now we need password change functionality.

```typescript
function changePassword(userId: string, oldPassword: string, newPassword: string) {
  // Get user
  const result = await db.query("SELECT * FROM users WHERE id = ?", [userId]);

  if (result.length === 0) {
    throw new Error("User not found");
  }

  const user = result[0];

  // Verify old password
  const isValid = bcrypt.compare(oldPassword, user.password);

  if (!isValid) {
    throw new Error("Current password is incorrect");
  }

  // Validate new password
  if (!newPassword || newPassword.length < 8) {
    throw new Error("Password must be at least 8 characters");
  }

  // Hash new password
  const hashedPassword = bcrypt.hash(newPassword);

  // Update database
  await db.query("UPDATE users SET password = ? WHERE id = ?", [hashedPassword, userId]);

  return { success: true };
}
```

## The Problems Start Appearing

Look at what we have. Three functions. They work. But there are problems:

**Problem 1: Duplicated validation logic**

We validate passwords in `registerUser` and `changePassword`. Same rules, written twice. If we need to add a requirement like "must contain a number," we have to remember to update both places. We'll forget. They'll get out of sync.

**Problem 2: Duplicated password hashing**

We hash passwords in `registerUser` and `changePassword`. Same logic, written twice. If we want to switch from bcrypt to argon2, we update it in two places. If we add a third place that needs hashing (like password reset), we'll have three places.

**Problem 3: Password verification is inconsistent**

In `loginUser`, we check if the password is valid. We return "Invalid credentials" for security (don't leak whether the email exists). But we never validate the format of the password before comparing. Someone could send a password that's 100MB long and we'd waste time hashing it before comparing.

**Problem 4: Email validation is limited**

We only validate email format in `registerUser`. But what if we add an "update email" function later? We have to remember to validate there too. What if we need to check for duplicate emails? That logic isn't centralized anywhere.

**Problem 5: Database queries are scattered everywhere**

Every function builds its own SQL queries. If we switch from MySQL to PostgreSQL or MongoDB, we're updating multiple files. If we need to add caching, where does it go? If we need to add logging for every database operation, we're adding it in 10 different places.

**Problem 6: Testing is painful**

How do you test `registerUser` without hitting a real database? You can't easily mock the database because the SQL is inline. How do you test password validation without also testing hashing? You can't separate them.

**Problem 7: The code doesn't match how we think**

When you think about users, you think "a user has an email and password." But there's no User in our code. When you think about passwords, you think "passwords need to be strong and hashed." But there's no Password in our code. Everything is just functions and data flowing through them.

These problems aren't theoretical. They're real. They slow you down. They cause bugs. They make changes scary.

So what do we do?

## The Solution: Think About Responsibilities

Let's step back and think about what we're really dealing with.

We have a password. Not just a string. A password has rules. It needs to be at least 8 characters. It needs to be hashed before storage. It needs to be verifiable against a plain text input. These are all things a password is responsible for knowing how to do.

We have a user. A user has an email and a password. The email needs to be valid. The user needs to be able to verify credentials. These are things a user is responsible for.

We have authentication operations. Registering a user, logging in, changing passwords. These operations coordinate multiple things: checking if a user exists, creating new users, verifying credentials.

Notice what we're doing? We're identifying things that exist and what they're responsible for. This is the core of object-oriented thinking.

Let's build it.

## Building the Password Object

A password is responsible for being a secure password. What does that mean?

When you create a password, it should validate its own strength. When you need to verify a password, it should know how to check itself. When you need to store a password, it should already be hashed.

```typescript
class Password {
  private hashedValue: string;

  private constructor(hashedValue: string) {
    this.hashedValue = hashedValue;
  }

  static create(plainPassword: string): Password {
    // Validate strength
    if (!plainPassword || plainPassword.length < 8) {
      throw new Error("Password must be at least 8 characters");
    }

    if (!/[A-Z]/.test(plainPassword)) {
      throw new Error("Password must contain an uppercase letter");
    }

    if (!/[0-9]/.test(plainPassword)) {
      throw new Error("Password must contain a number");
    }

    // Hash it
    const hashed = bcrypt.hash(plainPassword);

    return new Password(hashed);
  }

  static fromHash(hashedValue: string): Password {
    return new Password(hashedValue);
  }

  verify(plainPassword: string): boolean {
    return bcrypt.compare(plainPassword, this.hashedValue);
  }

  getHash(): string {
    return this.hashedValue;
  }
}
```

Look at what we did. All password logic is now in one place. The validation rules? Inside Password. The hashing? Inside Password. The verification? Inside Password.

Notice the design: you can't create a Password with just `new Password(something)`. The constructor is private. You either use `Password.create(plainText)` when creating a new password, or `Password.fromHash(hash)` when loading from database. This forces the right behavior.

This is encapsulation. Encapsulation means bundling data (the hashed value) together with the operations on that data (validate, hash, verify) and hiding the internal details (the constructor is private, you can't access hashedValue directly). The Password class is responsible for everything about passwords, and it protects its internal state.

Now let's use it:

```typescript
// Creating a new password
const password = Password.create("MySecret123");

// Verifying a password
if (password.verify("MySecret123")) {
  console.log("Correct!");
}

// Getting the hash for storage
const hash = password.getHash();
```

Notice how much cleaner this is? You don't think about hashing. You don't think about validation. You just say "create a password" and it handles everything. If it's invalid, it throws an error immediately.

## Building the User Object

Now let's think about users. A user has an email and a password. The email needs to be valid. The user needs to be able to verify credentials.

```typescript
class User {
  private id?: string;
  private email: string;
  private password: Password;
  private createdAt: Date;

  constructor(email: string, password: Password, id?: string) {
    this.validateEmail(email);
    this.email = email;
    this.password = password;
    this.id = id;
    this.createdAt = new Date();
  }

  private validateEmail(email: string): void {
    if (!email || !email.includes("@") || !email.includes(".")) {
      throw new Error("Invalid email format");
    }
  }

  verifyPassword(plainPassword: string): boolean {
    return this.password.verify(plainPassword);
  }

  changePassword(oldPassword: string, newPassword: string): void {
    if (!this.password.verify(oldPassword)) {
      throw new Error("Current password is incorrect");
    }

    this.password = Password.create(newPassword);
  }

  getEmail(): string {
    return this.email;
  }

  getId(): string {
    if (!this.id) {
      throw new Error("User has not been saved yet");
    }
    return this.id;
  }

  setId(id: string): void {
    if (this.id) {
      throw new Error("Cannot change user ID");
    }
    this.id = id;
  }

  toDatabase() {
    return {
      id: this.id,
      email: this.email,
      passwordHash: this.password.getHash(),
      createdAt: this.createdAt,
    };
  }

  static fromDatabase(data: any): User {
    const password = Password.fromHash(data.passwordHash);
    return new User(data.email, password, data.id);
  }
}
```

Again, all user logic is in one place. Email validation? In User. Password verification? In User (but it delegates to Password). Changing passwords? In User (but it uses Password to validate the new one).

Notice how `changePassword` works. The User asks the Password to verify the old one. Then it asks Password to create a new one (which validates strength automatically). The User coordinates, but each object does its own job.

This is abstraction. The User doesn't know HOW the Password hashes or verifies. It doesn't need to. It just knows it can ask the Password to do those things. The complex details of password hashing are hidden behind a simple interface: verify() and create(). This lets us change the hashing algorithm inside Password without touching the User class.

Now let's use it:

```typescript
// Creating a new user
const password = Password.create("MySecret123");
const user = new User("user@example.com", password);

// Verifying credentials
if (user.verifyPassword("MySecret123")) {
  console.log("Logged in!");
}

// Changing password
user.changePassword("MySecret123", "NewSecret456");
```

Clean, simple, obvious. The code reads like what you're trying to do.

## The Repository Pattern: Separating Storage

We still have a problem. Our User class is clean, but where does database logic go? We need to save users, find them, delete them.

We could put database methods inside User. But think about what User is responsible for: user identity and credentials. Storage is a different responsibility. What if we need to switch databases? What if we need to add caching? That shouldn't affect the User class.

Let's create a separate object responsible for storage:

```typescript
interface UserRepository {
  save(user: User): Promise<void>;
  findByEmail(email: string): Promise<User | null>;
  findById(id: string): Promise<User | null>;
  delete(userId: string): Promise<void>;
}

class DatabaseUserRepository implements UserRepository {
  constructor(private db: Database) {}

  async save(user: User): Promise<void> {
    const data = user.toDatabase();

    if (data.id) {
      // Update existing
      await this.db.query("UPDATE users SET email = ?, password_hash = ? WHERE id = ?", [
        data.email,
        data.passwordHash,
        data.id,
      ]);
    } else {
      // Insert new
      const result = await this.db.query(
        "INSERT INTO users (email, password_hash, created_at) VALUES (?, ?, ?)",
        [data.email, data.passwordHash, data.createdAt]
      );

      user.setId(result.insertId);
    }
  }

  async findByEmail(email: string): Promise<User | null> {
    const result = await this.db.query("SELECT * FROM users WHERE email = ?", [email]);

    if (result.length === 0) {
      return null;
    }

    return User.fromDatabase(result[0]);
  }

  async findById(id: string): Promise<User | null> {
    const result = await this.db.query("SELECT * FROM users WHERE id = ?", [id]);

    if (result.length === 0) {
      return null;
    }

    return User.fromDatabase(result[0]);
  }

  async delete(userId: string): Promise<void> {
    await this.db.query("DELETE FROM users WHERE id = ?", [userId]);
  }
}
```

Now all database logic is in one place. If we switch from MySQL to PostgreSQL, we create a new PostgresUserRepository. If we need caching, we create a CachedUserRepository. The rest of our code doesn't change.

Notice we defined an interface first, then implemented it. This is dependency inversion. Our code depends on the abstraction (UserRepository interface), not the concrete implementation (DatabaseUserRepository). This means we can swap implementations easily.

## The Service Layer: Coordinating Operations

Now we have Users, Passwords, and a way to store them. But we still need to coordinate the registration and login process.

This is where services come in. A service coordinates multiple objects to accomplish a task. It's the orchestrator.

```typescript
class AuthService {
  constructor(private userRepository: UserRepository) {}

  async register(email: string, plainPassword: string): Promise<User> {
    // Check if user already exists
    const existingUser = await this.userRepository.findByEmail(email);

    if (existingUser) {
      throw new Error("User already exists");
    }

    // Create password (validates and hashes automatically)
    const password = Password.create(plainPassword);

    // Create user (validates email automatically)
    const user = new User(email, password);

    // Save user
    await this.userRepository.save(user);

    return user;
  }

  async login(email: string, plainPassword: string): Promise<string> {
    // Find user
    const user = await this.userRepository.findByEmail(email);

    if (!user) {
      throw new Error("Invalid credentials");
    }

    // Verify password
    if (!user.verifyPassword(plainPassword)) {
      throw new Error("Invalid credentials");
    }

    // Generate token
    const token = jwt.sign({ userId: user.getId() }, SECRET_KEY);

    return token;
  }

  async changePassword(userId: string, oldPassword: string, newPassword: string): Promise<void> {
    // Find user
    const user = await this.userRepository.findById(userId);

    if (!user) {
      throw new Error("User not found");
    }

    // Change password (validates automatically)
    user.changePassword(oldPassword, newPassword);

    // Save updated user
    await this.userRepository.save(user);
  }
}
```

Look at how clean this is. The service doesn't validate emails. It doesn't hash passwords. It doesn't build SQL queries. It just coordinates:

- "UserRepository, check if this email is taken"
- "Password, create yourself from this plain text"
- "User, create yourself with this email and password"
- "UserRepository, save this user"

Each object does its job. The service just tells them when.

## Using the System

Now let's see how this all comes together:

```typescript
// Setup
const db = new Database();
const userRepository = new DatabaseUserRepository(db);
const authService = new AuthService(userRepository);

// Register a user
const user = await authService.register("user@example.com", "MySecret123");

// Login
const token = await authService.login("user@example.com", "MySecret123");

// Change password
await authService.changePassword(user.getId(), "MySecret123", "NewSecret456");
```

Compare this to our original procedural code. What have we gained?

**No duplicated logic**

Password validation? Only in Password.create(). Email validation? Only in User constructor. Password hashing? Only in Password.create(). Each piece of logic exists in exactly one place.

**Easy to test**

Want to test Password? Just test the Password class. Want to test User? Just test the User class. Want to test AuthService without hitting a database? Create a fake UserRepository:

```typescript
class FakeUserRepository implements UserRepository {
  private users: User[] = [];

  async save(user: User): Promise<void> {
    this.users.push(user);
  }

  async findByEmail(email: string): Promise<User | null> {
    return this.users.find((u) => u.getEmail() === email) || null;
  }

  // ... other methods
}

// Now test without database
const authService = new AuthService(new FakeUserRepository());
```

**Easy to change**

Need to add password strength indicators? Update Password class. Need to add "remember me" functionality? Add it to AuthService. Need to switch to MongoDB? Create MongoUserRepository. Each change is localized.

**Code matches your thinking**

When you think about users, there's a User class. When you think about passwords, there's a Password class. When you think about authentication, there's an AuthService. The code matches your mental model of the problem.

## Understanding the Principles Through What We Built

Let's look at what we actually did:

**Encapsulation**

We bundled related data and behavior together. The Password class contains the hashed value AND the methods to validate, hash, and verify. We made the constructor private to control how Passwords are created. We made hashedValue private so nobody can modify it directly. The Password class is responsible for its own correctness.

In interview terms: Encapsulation is bundling data with the methods that operate on that data, and restricting direct access to some of the object's components. It's about hiding internal state and implementation details while exposing only what's necessary through a well-defined interface.

**Abstraction**

The User class doesn't know HOW passwords are hashed. It just knows it can call password.verify(). The AuthService doesn't know HOW users are stored. It just knows it can call userRepository.save(). Complex implementation details are hidden behind simple interfaces.

In interview terms: Abstraction is hiding complex implementation details and exposing only the essential features. It allows you to focus on what an object does rather than how it does it, reducing complexity and making the system easier to understand and modify.

**Polymorphism**

We used interfaces like UserRepository. The AuthService doesn't care if it's a DatabaseUserRepository or a CachedUserRepository or a FakeUserRepository. As long as it implements the interface, it works. Same interface, different implementations.

In interview terms: Polymorphism is the ability of different objects to respond to the same interface in different ways. It allows you to write code that works with abstractions rather than concrete implementations, making the system more flexible and extensible.

**Inheritance**

We haven't used it yet. And that's intentional. Most OOP problems don't need inheritance. We used composition instead: User HAS a Password. AuthService HAS a UserRepository. This is often better than inheritance.

But when would we use it? Maybe if we needed different types of users: AdminUser, GuestUser. They'd all be Users but with different permissions. Or different types of authentication: PasswordAuth, OAuthAuth, BiometricAuth. They'd all implement an Authentication interface but work differently.

In interview terms: Inheritance is a mechanism where a new class is derived from an existing class, inheriting its properties and methods. It promotes code reuse and establishes relationships between types, though composition is often preferred for its flexibility.

## The Mental Model

Here's the shift in thinking:

**Procedural thinking:** What are the steps?

1. Get input
2. Validate it
3. Process it
4. Store it
5. Return result

**Object-oriented thinking:** What are the things, and what is each thing responsible for?

- Password is responsible for being secure
- User is responsible for user identity
- UserRepository is responsible for storage
- AuthService is responsible for coordinating authentication

Stop thinking about steps. Start thinking about actors and responsibilities.

When you write a new feature, ask:

- What things exist in this problem?
- What is each thing responsible for?
- What does each thing need to know to do its job?
- How do these things interact?

Build your objects around these answers. Let each object protect its own correctness. Let services coordinate the objects. Keep things simple and focused.

That's OOP. Not inheritance hierarchies or design patterns. Just clear responsibilities, well-defined interfaces, and objects that know how to do their jobs.

## Practice

Try building something yourself. Pick a real problem:

- A shopping cart system (Cart, Product, CartItem, Order, Payment)
- A task manager (Task, TaskList, User, Assignment, DueDate)
- A blog system (Post, Comment, Author, Tag, Category)

Don't start with code. Start with questions:

- What are the things that exist?
- What is each responsible for?
- How do they interact?

Write down the answers. Then build the objects. Then build the services. Then see how clean your code becomes.

This is how you learn to think in objects.
