<div align="center">

<img src="logo.png" alt="derAutor" width="120" />

# derAutor

**Your ghostwriter. Powered by AI. Sworn to secrecy.**

*Hand it a world and a spark. It writes you the whole book — and never spoils the ending.*

[![build](https://github.com/righttechsoft/derAutor/actions/workflows/build.yml/badge.svg)](https://github.com/righttechsoft/derAutor/actions/workflows/build.yml)
[![platforms](https://img.shields.io/badge/platforms-Windows%20%C2%B7%20macOS%20%C2%B7%20Linux-6c6c78)](https://github.com/righttechsoft/derAutor/releases)
[![FB2](https://img.shields.io/badge/exports-FB2-c99a4b)](#read-it-anywhere)

</div>

---

## The pitch

You describe a world. You hint at where the story begins. derAutor does the rest —
plotting the backbone, planning every chapter, writing the prose, re-reading the whole
manuscript for continuity, and painting the illustrations if you want them. A novel-length
book, start to finish, while you watch nothing but a progress bar.

Because here's the trick: **the app never shows you the story until it's done.** No leaked
twists, no half-drafts spoiling the ride. When the last page is written, you unlock your book
and read it the way it was meant to be read — cold, whole, and yours.

## Why it's different

- **📖 Whole books, not snippets.** A structured pipeline — story backbone → per-chapter plans → reader prose → a full-book review pass — produces a coherent manuscript, not a pile of disconnected chapters.
- **🤫 Zero spoilers by design.** Until the book reaches *done* and you type its title to unlock the Author's Room, the UI shows only word counts and progress. The story stays sealed.
- **🎨 Style-locked illustrations.** Optional cover and per-chapter art, every image anchored to the same visual style so the book looks like one artist made it.
- **🌍 Any language, one click.** Finished a book in Russian? Translate the whole thing into English — or nine other languages — while the original stays untouched.
- **✍️ Guided mode.** Prefer to co-write? Watch every step live and approve, regenerate, edit, or chat to refine it before the book moves on.
- **♻️ Living worlds.** Start a sequel that inherits everything — the world bible, characters, style, and continuity ledger — from a book you already finished.
- **📚 Read it anywhere.** Exports to **FB2**, the open e-book format, ready for any reader you like.

## How it works

```
   your world + premise
            │
       clarify  ──▶  a short interview to pin down the world
            │
        bible   ──▶  brief · world bible · characters · outline · style guide
            │
      chapters  ──▶  plan → prose → summary, chapter by chapter, in continuity
            │
       review   ──▶  re-read the whole book, flag issues, rewrite, re-check
            │
    illustrate  ──▶  (optional) cover + one image per chapter
            │
        export  ──▶  spoiler-free blurb, genre, pen name
            │
          done  ──▶  🔓 unlock the Author's Room and read
```

Everything after *clarify* runs hidden. You just wait.

## Under the hood

- **Electron + TypeScript**, React + zustand renderer, all state in **SQLite** (`node:sqlite` — no native modules, no rebuild pain).
- Three interchangeable AI backends: the **Anthropic API**, your **Claude subscription** (via the Agent SDK), or a fully offline **mock pipeline** for testing.
- Every step is **checkpointed** — kill the app mid-book, reopen it, and it resumes exactly where it left off without paying for a single duplicate call.
- Illustrations via **gpt-image-1**, style-anchored to the cover.

## Get it

Grab a ready-to-run installer for your platform from the
**[latest release](https://github.com/righttechsoft/derAutor/releases)** —
Windows (`.exe`), macOS (`.dmg`), or Linux (`.AppImage`).

### Build from source

```bash
npm install
npm run dev          # hot-reloading dev build
npm test             # unit + end-to-end pipeline
npm run package      # bundle + Windows installer
```

Prefer to try it without spending a cent on tokens? Run the whole pipeline offline against
deterministic fixtures:

```bash
MOCK_LLM=1 npm run dev
```

---

<div align="center">

*Made by [RightTech](https://github.com/righttechsoft). Bring your own API key.*

</div>
