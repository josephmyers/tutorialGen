# Statement of Purpose: Scripted Tutorial Video Generator

## 1. Purpose

A command-line tool that reads a single input script and produces a finished
tutorial video. The script contains both the narration to be spoken and the
browser actions to be performed. The tool generates spoken narration from the
script, drives a real browser through the actions while recording one
continuous video, and combines the narration with that video into a single
finished file.

The goal is to turn a plain-text description of a tutorial into a watchable
tutorial video with no manual recording, editing, or voice-over work.

## 2. What it does

```
tutorialGen transcript.md --url site.com --out tutorial.mp4
```

It takes an input script file and a starting URL and produces a single video file. It is
somewhat repeatable — the same input yields the same video, but TTS can vary the audio slightly.

## 3. Input format

A plain-text file. Two kinds of lines, distinguished by a leading marker:

- **Action lines** begin with `#`. These are commands performed inside the
  browser. Each action line is exactly **one command with one target** (see
  Section 7).
- **Narration lines** have no marker. These are spoken aloud via TTS.

Line order is execution order. Example:

```
#Click "login" to expand the sign-in form
Hello, and welcome to the training video. Today we'll show you how to log in.
#Click "username"
#Type "user1234"
#Click "password"
#Enter "test1234"
Here, you can see we've entered our username and password. Now, let's log in.
#Select "Sign In"
```

Each action line is a command and a single quoted
target. Any text after
the quoted target on an action line is treated as an inline comment for the
author and ignored by the parser.

## 4. Execution model

The tool runs in **two passes**.

**Pass 1 — narration generation.** Before any recording, the tool generates a
TTS audio clip for every narration line and measures each clip's duration.
After this pass, every narration segment has a known, fixed duration. Doing all
TTS up front means the run has every duration it needs before recording begins.

**Pass 2 — recording.** The tool runs a **sequential event queue**. Each line is
one segment. Segments run one at a time, in order, and each blocks
until it fully completes before the next begins:

- A **narration** segment does not play audio during the run. It holds the
  browser in place for the clip's known duration (from Pass 1), records the
  video timestamp at which the clip should begin, then advances. The clip's
  known duration is the timer.
- An **action** segment performs its browser operation and blocks until the
  browser confirms the operation is genuinely complete (e.g. navigation
  settled, target element present and actionable).

Because nothing overlaps, there is no audio/video synchronization problem to
solve. Each narration clip is later placed in the narration segment at the timestamp where the
queue paused, so picture and sound line up by
construction — the same duration value drives both the pause during recording
and the placement afterward.

**Completion detection is the load-bearing component for action segments.** As with any automation,
the browser driver must reliably wait for real readiness signals before returning
control to the queue. Long-running site operations (e.g. a 4-second page load)
are handled by waiting, not by timing assumptions.

## 5. Recording model

The tool records the browser session as one continuous video take from start
to finish. Frames are captured from the headless browser at a **fixed cadence
driven by the tool** — a screencast frame stream consumed at a fixed rate and
encoded to video — rather than by the browser's own change-triggered native
recording.

This is a deliberate choice, not an implementation detail. A narration segment
holds the page still by design, and a change-triggered recorder can
under-represent stillness, so an N-second hold might not encode as N seconds of
video and narration placement would drift further out with each clip. Driving
the cadence makes N seconds always N × fps frames, so video time equals
wall-clock time by construction and the timeline in Section 4 is sound.

This recording is **silent** — no audio is captured live, the machine's speakers
are never used, and no live-playback completion detection is needed.

During the recording pass, the tool keeps a timeline noting, for each narration
segment, the video timestamp at which its clip should begin (see Section 4).
After the run completes, the narration clips generated in Pass 1 are muxed onto
the single continuous video at those timestamps, producing the finished file
with sound.

This is a single, unbroken video take — there is no segmenting or stitching of
video clips. Only the audio is added afterward, and it lands at known timestamps
that already correspond to equal-length pauses recorded into the video. The
result is one continuous recording.

**This approach is headless.** The browser runs without a visible window, the OS
pointer is never moved, and the machine stays usable during a run — all input is
dispatched as synthetic browser events. It is *not* non-invasive with respect to
the page under test: a cursor overlay is injected into the document (Section 8).

## 6. Parsing and element resolution

These are two separate stages.

**Parsing (command → structured action).** Action lines are *not* interpreted as
free-form natural language. Each line is a command
from a small, closed, documented vocabulary (Section 7), written as a verb (or
one of its synonyms) plus one quoted target. A verb-synonym table normalizes
variants to a canonical command; the quoted text is taken verbatim as the
target. The parser produces a structured action, e.g. `Click "Sign In"` →
`{command: click, target: "Sign In"}`. Anything that does not match a known
command is a parse error reported at load time, with a clear message.

**Resolution (target → live DOM element).** Given a structured action's target
string, the browser driver locates the actual element using a stable
attribute-based strategy — a priority chain of locator strategies (e.g. visible
text/label, ARIA role/label, `name`). Exact strategy and priority
order are an implementation detail, but resolution must be based on attributes
elements reliably have.

The parser's job ends at producing the structured action; the resolver's job is
finding the element. Fusing the two is prohibited.

## 7. Command vocabulary

A closed set of commands covering the mouse-and-keyboard interaction surface
needed for tutorials. Each command has a canonical name and a curated set of
synonyms; every synonym maps to exactly one command, with no overlaps. Each
action line is one command and one quoted target.

| Command | Synonyms | Target |
|---|---|---|
| `click` | select, press, tap | quoted element |
| `doubleclick` | double-click, double click | quoted element |
| `type` | enter, input, write, hit | quoted text |
| `hover` | mouse over, move to, point at | quoted element |
| `scroll up` | scroll up | an amount |
| `scroll down` | scroll down | an amount |
| `scroll to` | scroll to | quoted element |
| `drag` | drag by | an amount |
| `wait` | pause | an amount |

Per-command specifics:

- **`type`** goes into whichever field was last focused by a preceding `click`.
It can also be used for keyboard shortcuts, like "Ctrl+C".
- **`drag`** drags from the current pointer location, by
the given amount. To be used with the `hover` command.
- **`wait`** holds the page still, doing nothing, for the given number of
milliseconds. For letting something on the page play out on screen.

Resolved naming conflicts (recorded so they are not reintroduced): `select`
always means `click` (never highlight-text or dropdown-choose); `enter` always
means `type`. Element-to-element
drag, dropdown selection, right-click, and in-line navigation are
intentionally out of scope for v1 and go on the expand-later list.

## 8. Visual presentation

Raw automated interaction looks robotic. The recording should include human-like
affordances so the output is watchable:

- Smooth cursor movement between targets (not instant jumps)
- Character-by-character typing rather than instant field fills

**The cursor is drawn, not real.** Automation dispatches synthetic input events
and never moves the OS pointer, so no pointer appears in captured frames. The
tool injects a cursor overlay into the page and animates it between targets.

- The overlay must be re-injected on every navigation, since a new document
  wipes it (e.g. Playwright's `addInitScript`).
- Overlay movement must be driven by the same coordinates the synthetic click
  uses, so the drawn cursor and the real interaction can never disagree.

Recorded so it is not reintroduced: running headed does **not** solve this. A
headed browser also renders no pointer for synthetic events. The only approach
that yields a genuine cursor is OS-level pointer control, which takes over the
machine for the duration of the run and is rejected.

## 9. Explicitly deferred

- **TTS quality / engine choice.**
- **Concurrent narration + action ("talk while doing").**
- **Automatically inserted silence/static-screen filler.** Authored pauses are
supported — see `wait` in §7.

## 10. Help documentation

The tool ships with concise built-in help — enough to write a valid script, no
more. It is not a manual. It covers:

- The two line types (`#` action lines; unmarked narration lines) and that order
  is execution order.
- The one-command-one-target rule.
- The command table from Section 7, plus any per-command notes.
- The short example from Section 3.

## 11. Component summary

| Component | Responsibility |
|---|---|
| Parser | Read the input file; split into ordered narration and action segments; normalize each action's verb via the synonym table and take the quoted text as the target, producing a structured action; report unknown commands as load-time errors. |
| TTS (Pass 1) | Generate an audio clip for every narration line and measure each clip's duration, before recording begins. |
| Queue/engine (Pass 2) | Dispatch segments sequentially; block on each until complete; hold the browser for each narration clip's known duration and record its start timestamp; wait on real completion signals for actions. |
| Browser driver / resolver | Open and drive a real headless browser instance; resolve each structured action's target string to a live DOM element (attribute-based locator chain); perform the action; detect completion; maintain the injected cursor overlay across navigations. |
| Recorder | Capture frames from the headless browser at a fixed, tool-driven cadence and encode them into one continuous silent video, so video time tracks wall-clock time. |
| Compositor (mux) | Place the narration clips onto the silent continuous video at their recorded timestamps to produce the finished file. |
| Output | Produce a single video file. |

## 12. First milestone

A working prototype that runs the example in Section 3 end to end against a real
site: generating narration clips, recording one continuous silent video of the
browser actions, and muxing the narration onto it to produce a single playable
video with synchronized narration and browser actions.

Because Section 5 (continuous silent recording plus muxed narration) and action
completion detection (Section 4) are the parts most likely to need runtime
trial-and-error, it is worth prototyping that slice first — one narration clip
plus one action, recorded and muxed into a playable file — before building out
the full command vocabulary.
