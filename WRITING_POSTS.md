# How to Write a New Blog Post

Writing a new blog post is super easy! Just create a new Markdown file.

## Steps to Add a New Post

### 1. Create a new `.md` file in `content/posts/`

The filename will become the URL slug. For example:

- `my-first-post.md` → `/blog/my-first-post`
- `understanding-kafka.md` → `/blog/understanding-kafka`

### 2. Add frontmatter at the top

Every blog post needs frontmatter (metadata) at the very top:

```markdown
---
title: "Your Post Title Here"
date: "2025-10-14"
readTime: "10 min read"
---

Your actual blog content starts here...
```

### 3. Write your content in Markdown

After the frontmatter, write your blog post using standard Markdown syntax:

```markdown
---
title: "My Awesome Post"
date: "2025-10-14"
readTime: "5 min read"
---

This is the introduction paragraph.

## Main Heading

Some content here with **bold** and _italic_ text.

### Sub Heading

- List item 1
- List item 2
- List item 3

## Code Examples

Inline code: `const x = 10`

Code blocks:

\`\`\`javascript
function hello() {
console.log("Hello, world!");
}
\`\`\`

\`\`\`sql
SELECT \* FROM users WHERE active = true;
\`\`\`

## Links

[Link to Google](https://google.com)

## Blockquotes

> This is a quote from someone famous.

## Conclusion

Wrap it up here!
```

### 4. That's it!

The blog will automatically:

- Show your new post on the home page (`/`)
- Add it to the blog list (`/blog`)
- Add it to the archive (`/archive`)
- Create the route (`/blog/your-slug`)

## Markdown Syntax Supported

- `# Heading 1` (not recommended, use for title in frontmatter)
- `## Heading 2`
- `###  Heading 3`
- `**bold text**`
- `*italic text*`
- `` `inline code` ``
- Code blocks with syntax highlighting (use triple backticks)
- `[Links](https://example.com)`
- `> Blockquotes`
- Unordered lists (`-` or `*`)
- Ordered lists (`1.`, `2.`, etc.)
- Tables
- Horizontal rules (`---`)

## Example Post

See `content/posts/consensus-algorithms-raft.md` for a complete example!

## Tips

1. **Use descriptive slugs**: The filename becomes the URL, so use kebab-case (words-separated-by-dashes)
2. **Date format**: Use `YYYY-MM-DD` format for dates
3. **Read time**: Estimate based on ~200 words per minute
4. **Test locally**: Run `pnpm dev` and visit `http://localhost:3000/blog/your-slug` to preview

## Need Help?

- Check existing posts in `content/posts/` for examples
- All posts are sorted by date (newest first)
- The system automatically handles everything - no need to edit code!
