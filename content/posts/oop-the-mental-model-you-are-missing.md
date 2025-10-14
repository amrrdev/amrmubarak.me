---
title: "Object-Oriented Programming: The Mental Model You're Missing"
date: "2025-10-15"
readTime: "15 min read"
---

## Why You Still Don't Get It

You've watched the tutorials. You've read the articles. You know what encapsulation means. You can define polymorphism. But when you sit down to write code, you still think in functions and steps. You still write procedural code dressed up in classes.

The problem isn't that you don't know OOP. The problem is that nobody taught you how to think in objects. They taught you the vocabulary but not the language. They showed you the syntax but not the mindset.

This changes now.

## The Fundamental Shift: Stop Writing Recipe Code

Here's what most developers do when building an authentication system:

```typescript
function registerUser(email: string, password: string) {
  // Step 1: validate email
  if (!email.includes("@")) throw new Error("Invalid email");

  // Step 2: hash password
  const hash = bcrypt.hash(password);

  // Step 3: save to database
  await db.query("INSERT INTO users...");

  // Step 4: send email
  await sendEmail(email, "Welcome!");
}
```

This is recipe thinking. Do step 1, then step 2, then step 3. It works, but it's a nightmare to maintain. Where do you add password strength validation? Where do you handle duplicate emails? How do you test this without hitting the database?

The core problem: you're thinking about the steps to accomplish a task, not about the things that exist in your system and what they're responsible for.

## The Philosophy: Your System Is Made of Responsible Actors

In your application, there are entities that exist. Not just data structures. Not just database tables. Actual things with behavior.

When you're building authentication, you have:

- Users who have credentials and can verify them
- Passwords that need to be secure and can validate themselves
- Tokens that expire and can verify themselves
- Sessions that track activity

These aren't just pieces of data you shuffle around. They're actors in your system. Each one knows how to do its job.

The mental shift is this: instead of writing functions that manipulate data, you create objects that are responsible for their own behavior. You don't manipulate a password. You ask a password to verify itself. You don't manually check if a token is expired. You ask the token if it's still valid.

## The Core Questions That Build Your Mental Model

### What are the things that exist in my problem space?

When you look at a feature, identify the nouns that matter. Not just any nouns. The ones with behavior.

Building a payment system? You have Payments, Transactions, Refunds, PaymentMethods. These things do stuff. A Payment can be captured, refunded, voided. A Transaction records what happened. A PaymentMethod knows how to process charges.

Building a blog? You have Posts, Comments, Authors. A Post knows when it was published. A Comment can be marked as spam. An Author has a reputation score that changes.

The key is recognizing that these aren't just database tables. They're concepts in your domain that have rules and behavior.

### What is each thing responsible for?

This is where most people struggle. They know they need a User class, but they don't know what belongs in it.

Here's the rule: each object should own everything related to one concept, and nothing else.

A User owns user identity. It knows its email. It knows its password. It can verify credentials. It can change its email. It validates that emails are properly formatted.

A User does NOT save itself to a database. It does NOT send emails. It does NOT log audit trails. Those are different concepts. They belong to different objects.

Why this matters: when you need to change how passwords work, you change the Password class. When you need to change how emails are sent, you change the EmailService. When you need to change how users are stored, you change the UserRepository. Each change is isolated to one place.

### How do these things interact?

Individual objects are simple. They do one thing well. But your application does complex things. So how do you coordinate them?

This is where services come in. Services are coordinators. They don't do the work themselves. They delegate to the right objects.

When a user registers:

- The service asks Password to create itself from plain text (Password knows how to hash and validate strength)
- The service asks User to create itself with that password (User knows how to validate emails)
- The service asks UserRepository to save the user (Repository knows how to persist data)
- The service asks EmailService to send a welcome email (EmailService knows how to send emails)

The service orchestrates. It says who does what and in what order. But it doesn't do the actual work. Each object is responsible for its own part.

## The Mental Model: Message Passing Over Method Calls

Stop thinking "I'm calling this method." Start thinking "I'm asking this object to do something."

The difference sounds subtle but it changes everything.

When you call a method, you're reaching into an object and making it do something. When you send a message, you're asking an object to handle something. The object decides how.

```typescript
// Manipulating an object
user.passwordHash = bcrypt.hash(newPassword);
user.passwordUpdatedAt = new Date();
user.failedLoginAttempts = 0;

// Asking an object to do something
user.changePassword(newPassword);
```

In the first version, you're managing all the complexity. You have to remember to update the timestamp. You have to remember to reset failed login attempts. You have to know how passwords are hashed.

In the second version, the User object handles all of that. You just ask it to change the password, and it takes care of everything. This is encapsulation in the true sense: the object protects its internal consistency.

## Building the Right Mental Model: Think in Layers

When you're designing a feature, think in three layers:

### Layer 1: Domain Objects (The Core Logic)

These are objects that exist independent of any technical detail. They don't know about databases. They don't know about HTTP. They don't know about frameworks.

A Password object just knows what it means to be a password. You can create one from plain text (it hashes itself). You can verify if a plain text matches (it checks the hash). You can't create an invalid password (it validates strength).

A User object just knows what it means to be a user. You have an email and a password. You can verify credentials. You can change your email (it validates the format).

These objects encode your business rules. Your business doesn't care if you use PostgreSQL or MongoDB. It doesn't care if you use Express or Fastify. The rules about what makes a valid password don't change based on technical choices.

This is the most important insight: your domain logic should be pure. No side effects. No dependencies on infrastructure. Just the rules of your business.

### Layer 2: Services (The Coordinators)

Services use your domain objects to accomplish tasks. They're your use cases.

An AuthService coordinates registration and login. It doesn't know HOW to hash passwords or HOW to save users or HOW to send emails. It just knows WHAT needs to happen and WHO to ask to do it.

```typescript
class AuthService {
  async register(email: string, plainPassword: string) {
    // Ask if user already exists
    const exists = await this.userRepository.exists(email);
    if (exists) throw new Error("User already exists");

    // Ask Password to create itself
    const password = Password.create(plainPassword);

    // Ask User to create itself
    const user = new User(email, password);

    // Ask Repository to save
    await this.userRepository.save(user);

    // Ask EmailService to send welcome email
    await this.emailService.sendWelcome(email);

    return user;
  }
}
```

Notice what the service does: it coordinates. It doesn't do the actual work. It asks objects to do their jobs.

### Layer 3: Infrastructure (The Technical Details)

This is where you implement the concrete details. The PostgresUserRepository that actually queries the database. The SendGridEmailService that actually sends emails. The bcrypt implementation of password hashing.

Your domain and services don't depend on these details. They depend on interfaces. This means you can change the implementation without touching your business logic.

## The Rules That Make OOP Work

### Rule 1: Objects protect their invariants

An invariant is something that must always be true. A User always has a valid email. A Password always meets strength requirements. An Order always has at least one item.

Don't rely on validation at the edges. Don't rely on documentation. Make invalid states impossible through your design.

If a User can exist without a valid email, your design is wrong. Fix it by making the constructor validate. Make changeEmail validate. Now it's impossible to have a User with an invalid email.

```typescript
class User {
  private email: string;

  constructor(email: string) {
    this.validateEmail(email);
    this.email = email;
  }

  private validateEmail(email: string): void {
    if (!email.includes("@") || !email.includes(".")) {
      throw new Error("Invalid email format");
    }
  }

  changeEmail(newEmail: string): void {
    this.validateEmail(newEmail);
    this.email = newEmail;
  }
}
```

Now you can trust that every User has a valid email. You don't need to check everywhere. The object enforces its own rules.

### Rule 2: Behavior lives with the data it operates on

If something operates on user data, it should be in the User class. Don't scatter user logic across 10 different files.

This is cohesion. Things that change together should be together.

When password hashing changes, you change the Password class. When email validation rules change, you change the User class. Each change is localized.

### Rule 3: Objects communicate through abstractions

Your AuthService shouldn't know about PostgresUserRepository. It should know about UserRepository (an interface).

```typescript
interface UserRepository {
  save(user: User): Promise<void>;
  findByEmail(email: string): Promise<User | null>;
  exists(email: string): Promise<boolean>;
}
```

Why? Two reasons:

First, testability. You can inject a FakeUserRepository in tests. No database needed.

Second, flexibility. You can swap implementations without changing the service. The service doesn't care HOW users are stored. It just knows it can ask something to store them.

This is dependency inversion. High-level logic (services) don't depend on low-level details (database implementations). Both depend on abstractions (interfaces).

### Rule 4: Make objects hard to misuse

Design your objects so that they're easy to use correctly and hard to use incorrectly.

Look at this Password class:

```typescript
class Password {
  private hashedValue: string;

  // Private constructor - you can't just create a Password with any string
  private constructor(hashedValue: string) {
    this.hashedValue = hashedValue;
  }

  // To create a new password, use this - it validates and hashes
  static create(plainPassword: string): Password {
    if (plainPassword.length < 8) {
      throw new Error("Password too short");
    }
    const hashed = this.hash(plainPassword);
    return new Password(hashed);
  }

  // To load an existing password from database, use this
  static fromHash(hashedValue: string): Password {
    return new Password(hashedValue);
  }

  verify(plainPassword: string): boolean {
    return this.hashedValue === Password.hash(plainPassword);
  }
}
```

You can't create a Password incorrectly. You either create a new one with `Password.create()` (which validates and hashes), or you load an existing one with `Password.fromHash()`. There's no way to bypass the validation.

This is good API design. The object guides you toward correct usage.

## The Design Process: How to Actually Think

When you start a new feature:

**Step 1: Understand the domain**

What are you building? Not technically. Conceptually. If you're building a payment system, understand payments. What states can a payment be in? What operations can you perform? What rules must be followed?

Don't jump to code. Understand the problem space first.

**Step 2: Identify the actors**

What things exist? What are the important nouns? Write them down.

For a payment system: Payment, Transaction, PaymentMethod, Money, Receipt, Refund.

For a blog: Post, Comment, Author, Tag, Category.

For authentication: User, Password, Token, Session.

**Step 3: Define responsibilities**

For each actor, write one sentence describing what it's responsible for.

"A Payment is responsible for tracking payment state and ensuring valid state transitions."
"A User is responsible for user identity and credential verification."
"An AuthService is responsible for coordinating the registration and authentication process."

If you can't write one clear sentence, the responsibility isn't clear. Split it up.

**Step 4: Identify dependencies**

What does each actor need to do its job? Keep dependencies minimal.

A Password needs nothing. It's self-contained.
A User needs a Password. That's it.
An AuthService needs a UserRepository and an EmailService.

Draw this out. If you see circular dependencies, you've got a design problem. Fix it before you code.

**Step 5: Start with domain objects**

Write your domain objects first. No database code. No HTTP code. Just pure logic.

Can you create a User? Can you verify its password? Can you change its email? Write the tests. Make them pass. Keep it simple.

**Step 6: Add services**

Now write your services. They use your domain objects. They coordinate operations.

Can you register a user? Can you log in? Can you reset a password? Again, write tests. Make them pass.

**Step 7: Add infrastructure last**

Finally, implement the technical details. Database repositories. Email sending. HTTP controllers.

These depend on your domain and services. Your domain and services don't depend on these.

## Common Mistakes and How to Fix Them

### Mistake: God Objects

You create a User class that does everything. Authentication, database access, email sending, session management, logging, analytics...

Fix: Split responsibilities. User is just identity and credentials. AuthService handles authentication logic. UserRepository handles persistence. EmailService handles emails. Each class has one job.

### Mistake: Anemic Domain Model

Your objects are just data containers. All the logic is in services.

```typescript
class User {
  email: string;
  passwordHash: string;
}

class UserService {
  validateEmail(user: User) { ... }
  changePassword(user: User, newPassword: string) { ... }
  isActive(user: User) { ... }
}
```

This is just procedural code with extra steps. You've gained nothing from OOP.

Fix: Move behavior into the object. The User should validate its own email. The User should change its own password. The User should know if it's active.

### Mistake: Inheritance Overuse

You create deep inheritance hierarchies. User extends Person extends Entity extends BaseModel...

Fix: Prefer composition. Use interfaces. A User doesn't need to inherit from anything. It can implement interfaces and compose behavior from other objects.

### Mistake: Public Everything

All your properties are public. Anyone can modify anything.

Fix: Make everything private by default. Expose only what's necessary through methods. Let the object control its own state.

### Mistake: Premature Abstraction

You create interfaces and abstractions before you need them. You write generic frameworks before you've built a single concrete implementation.

Fix: Start concrete. Write real code for real use cases. When you see patterns emerge, THEN abstract. Don't abstract speculatively.

## The Real Secret: It's About Managing Complexity

Here's what nobody tells you: OOP isn't about being clever. It's about managing complexity.

As your system grows, complexity grows exponentially. More features, more edge cases, more interactions. Without structure, this becomes unmaintainable.

OOP gives you structure:

- Objects let you break complexity into small, manageable pieces
- Encapsulation lets you hide complexity behind simple interfaces
- Abstraction lets you ignore irrelevant details
- Composition lets you build complex behavior from simple parts

When you write good OOP code, you can understand each piece in isolation. You don't need to hold the entire system in your head. You can focus on one object, one responsibility, one interaction at a time.

That's the goal. Not clever design patterns. Not perfect hierarchies. Just manageable complexity.

## Practice: Build a Real System

Want to master OOP thinking? Build a task management system.

Don't just code it. Think through it:

What are the actors? (Task, TaskList, User, Assignment, Comment, DueDate, Priority)

What is each responsible for? (A Task knows its state and can transition states. A DueDate knows if it's overdue. A TaskList contains tasks and can filter them.)

How do they interact? (TaskService coordinates task creation and assignment. NotificationService watches for overdue tasks.)

Start with domain objects. No database. No API. Just objects with behavior. Write tests. Make sure a Task can be created, completed, reopened. Make sure a DueDate can calculate if it's overdue.

Then add services. Then add infrastructure.

This is how you build the mental model. By doing it. By asking these questions. By making mistakes and fixing them.

## The Mindset

OOP thinking is about responsibility and boundaries.

Every object has clear responsibility. Every object protects its boundaries. Every object does its job without needing to know how other objects do theirs.

When you write code, ask:

- What is this object responsible for?
- What does it need to know to do its job?
- What should be hidden?
- What should be exposed?
- Who coordinates this object with others?

Stop thinking in steps. Start thinking in actors and responsibilities.

That's the shift. That's how you think in objects.
