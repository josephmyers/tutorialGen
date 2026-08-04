# TutorialGen

A tool for generating videos. Supply an input script with narration and actions, paired with the target site url, to generate a video executing the instructions at that site.

## Basic Usage

Powershell:

```bash
npm start yourScript.txt -- --url "your-site"
```

The output will be an .mp4 with the same name as the input script, unless specified otherwise via `--out`.

## Script

The script is processed with the parser, which is designed to accept both narration and actions.

Action lines are signaled with the `#` tag and formed from a vocabulary set of verbs and their targets in quotes. Each action line is composed of one verb and one target. Use `--help` for more details on the available verbs. Targets, when they are elements and not amounts (e.g. `#Wait "2000"`), are found via `resolver.ts`. See that file for a full list of the prioritized resolution chain, but generally it's easiest for the target to be the element's `aria-label`, assuming it's unique.

All other lines are narrated by the TTS engine, Edge TTS. You can change the voice with `--voice`.

#### Example Script

```
Let's log in.
#Click "username"
#Type "[username]"
#Click "password"
#Enter "[password]"
#Select "login"
This is the Home page. Let's select a team.
#Click "Default team"
Let's select a project.
#Select "project"
Let's go to a passage.
#Hover "play GEN 1:1-2"
#Scroll down "200"
#Click "Open Passage 9"
On this page, you can see the audio for the current passage.
To play the passage audio, click Play.
#Click "passage play"
#Wait "2000"
#Click "passage pause"
You can move the marker by clicking into the audio display.
#Click "passage waveform"
And you can select a range by clicking and dragging.
#Drag "100,0"
Thank you for watching this video.
```