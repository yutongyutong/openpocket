import { defineConfig } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsBaseRaw = process.env.DOCS_BASE?.trim() ?? "/";
const docsBase = docsBaseRaw.startsWith("/") ? docsBaseRaw : `/${docsBaseRaw}`;
const normalizedBase = docsBase.endsWith("/") ? docsBase : `${docsBase}/`;
const docsRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");

function stripInlineMarkdown(text) {
  return text
    .replace(/\s*\{#.+?\}\s*$/, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[*_~]/g, "")
    .replace(/<[^>]+>/g, "")
    .trim();
}

function toSlug(text) {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function linkToFilePath(link) {
  if (link === "/") {
    return resolve(docsRoot, "index.md");
  }

  if (link.endsWith("/")) {
    return resolve(docsRoot, `${link.slice(1)}index.md`);
  }

  return resolve(docsRoot, `${link.slice(1)}.md`);
}

function extractHeadingTree(link) {
  const filePath = linkToFilePath(link);
  let source = "";

  try {
    source = readFileSync(filePath, "utf8");
  } catch {
    return [];
  }

  const headingEntries = [];
  const slugCounters = new Map();
  let inFence = false;

  for (const line of source.split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      continue;
    }

    const match = line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (!match) {
      continue;
    }

    const level = match[1].length;
    const text = stripInlineMarkdown(match[2]);
    if (!text) {
      continue;
    }

    const baseSlug = toSlug(text);
    if (!baseSlug) {
      continue;
    }

    const count = slugCounters.get(baseSlug) ?? 0;
    slugCounters.set(baseSlug, count + 1);
    const slug = count === 0 ? baseSlug : `${baseSlug}-${count}`;

    headingEntries.push({
      level,
      item: {
        text,
        link: `${link}#${slug}`,
        collapsed: false,
      },
    });
  }

  const tree = [];
  const stack = [];

  for (const entry of headingEntries) {
    while (stack.length > 0 && entry.level <= stack[stack.length - 1].level) {
      stack.pop();
    }

    if (stack.length === 0) {
      tree.push(entry.item);
    } else {
      const parent = stack[stack.length - 1].item;
      parent.items ||= [];
      parent.items.push(entry.item);
    }

    stack.push(entry);
  }

  return tree;
}

function withPageHeadings(items) {
  return items.map((item) => {
    if (item.items && !item.link) {
      return {
        ...item,
        collapsed: false,
        items: withPageHeadings(item.items),
      };
    }

    if (!item.link || item.link.startsWith("http")) {
      return item;
    }

    const headingItems = extractHeadingTree(item.link);
    if (headingItems.length === 0) {
      return item;
    }

    return {
      ...item,
      collapsed: false,
      items: headingItems,
    };
  });
}

const baseSidebar = [
  {
    text: "Overview",
    items: [
      { text: "Home", link: "/" },
      { text: "Documentation Hubs", link: "/hubs" },
    ],
  },
  {
    text: "Get Started",
    collapsed: false,
    items: [
      { text: "Index", link: "/get-started/" },
      { text: "Quickstart", link: "/get-started/quickstart" },
      { text: "Configuration", link: "/get-started/configuration" },
      { text: "Deploy Documentation Site", link: "/get-started/deploy-docs" },
    ],
  },
  {
    text: "Concepts",
    collapsed: false,
    items: [
      { text: "Index", link: "/concepts/" },
      { text: "Project Blueprint", link: "/concepts/project-blueprint" },
      { text: "Architecture", link: "/concepts/architecture" },
      { text: "Prompting and Decision Model", link: "/concepts/prompting" },
      { text: "Sessions and Memory", link: "/concepts/sessions-memory" },
    ],
  },
  {
    text: "Tools",
    collapsed: false,
    items: [
      { text: "Index", link: "/tools/" },
      { text: "Skills", link: "/tools/skills" },
      { text: "Scripts", link: "/tools/scripts" },
    ],
  },
  {
    text: "Reference",
    collapsed: false,
    items: [
      { text: "Index", link: "/reference/" },
      { text: "Config Defaults", link: "/reference/config-defaults" },
      { text: "Prompt Templates", link: "/reference/prompt-templates" },
      { text: "Action and Output Schema", link: "/reference/action-schema" },
      { text: "Session and Memory Formats", link: "/reference/session-memory-formats" },
      { text: "CLI and Gateway", link: "/reference/cli-and-gateway" },
      { text: "Filesystem Layout", link: "/reference/filesystem-layout" },
    ],
  },
  {
    text: "Ops",
    collapsed: false,
    items: [
      { text: "Index", link: "/ops/" },
      { text: "Runbook", link: "/ops/runbook" },
      { text: "Troubleshooting", link: "/ops/troubleshooting" },
    ],
  },
  {
    text: "Legacy",
    collapsed: true,
    items: [
      { text: "Implementation Plan", link: "/implementation-plan" },
      { text: "MVP Runbook (Legacy Entry)", link: "/mvp-runbook" },
    ],
  },
];

export default withMermaid(defineConfig({
  base: normalizedBase,
  lang: "en-US",
  title: "OpenPocket",
  description: "Local emulator-first phone-use agent for everyday workflows with auditable local control.",
  lastUpdated: true,
  cleanUrls: true,
  ignoreDeadLinks: [
    // Native app docs may not exist in all checkouts.
    /openpocket-menubar/,
  ],
  themeConfig: {
    siteTitle: "OpenPocket",
    logo: "/openpocket-logo.png",
    nav: [
      { text: "Home", link: "/" },
      { text: "Blueprint", link: "/concepts/project-blueprint" },
      { text: "Get Started", link: "/get-started/" },
      { text: "Reference", link: "/reference/" },
      { text: "Runbook", link: "/ops/runbook" },
      { text: "Doc Hubs", link: "/hubs" },
    ],
    socialLinks: [
      { icon: "github", link: "https://github.com/SergioChan/openpocket" },
    ],
    sidebar: withPageHeadings(baseSidebar),
    search: {
      provider: "local",
    },
    outline: {
      level: [2, 3],
    },
    footer: {
      message: "<a href=\"https://github.com/SergioChan/openpocket\" target=\"_blank\" rel=\"noreferrer\">GitHub Repository</a>",
      copyright: "MIT License · OpenPocket Contributors",
    },
  },
  markdown: {
    theme: {
      light: "github-light",
      dark: "github-dark",
    },
  },
  mermaid: {},
}));
