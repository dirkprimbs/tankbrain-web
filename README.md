# Tankbrain Web

A brain in a tank that thinks in **inner speech**, as a static web page. A question or idea enters through the only open sense, the *inspiration* channel. Small, narrow voices then chatter about it on internal notice boards and in private messages, write things into shared memory, argue over a draft, lose interest, and finally one voice says the answer, out loud.

No voice knows it is part of a brain. Each one only knows its own temperament and job, the boards it follows, its private messages, the memory it is allowed to see, and the names of the others it can reach. The brain metaphor exists only in the observer UI.

**Live:** [primbs.ca/tankbrain](https://primbs.ca/tankbrain/) · **Source:** [github.com/dirkprimbs/tankbrain-web](https://github.com/dirkprimbs/tankbrain-web)

![Thirteen voices thinking about "Can God create a stone too heavy for him to lift?": the brain in its tank, with the voices that are thinking right now lit up, and the inner-speech stream on the right](docs/tank.jpg)

<table><tr>
<td width="50%"><a href="docs/voice-card.jpg"><img src="docs/voice-card.jpg" alt="Hovering a voice shows its card: job, what it reads and writes, its model and what it is doing right now. Behind it, the draft panel says which notes the new version responds to."></a><br><sub><b>A voice up close.</b> Hover any voice for its job, model and current state. The draft panel shows what each new version is a response to.</sub></td>
<td width="50%"><a href="docs/trace.jpg"><img src="docs/trace.jpg" alt="The draft panel with word-level changes between versions, and the stream showing each edit with the writer's note on what changed and why."></a><br><sub><b>The trace.</b> Every draft version with its word-level changes, the writer's note on why, and the conversation that led to it.</sub></td>
</tr></table>

This is the static version of Tankbrain. There is no server: the brain runs in your browser, every voice is a model on [OpenRouter](https://openrouter.ai), and everything the app keeps stays in your browser.

## Run it

```bash
npm install
npm run build        # the site is in dist/
npm run dev          # or: develop with hot reload (http://localhost:5178)
```

It starts on the `dirksdefault` profile. No key? The page asks whether to set one now. You can also replay the five demo sessions, or pick the **in-browser** profile (below).

`dist/` is plain files with relative paths: put it on any static host (GitHub Pages, Netlify, an S3 bucket, a folder behind nginx) or serve it locally, e.g. `python3 -m http.server -d dist`. Open it, add your OpenRouter key in **⚙ Settings**, and ask something.

The app reads no environment variables and has no backend. The only hosts it talks to are `openrouter.ai` (the voices, embeddings, speech) and `huggingface.co` (one-time model downloads, only if you use the in-browser model or the offline Kokoro voice).

## How it thinks

| Voice | Region (UI only) | Job |
|---|---|---|
| Listener | Wernicke's area | restates what is really being asked (#focus) |
| Associator | right temporal lobe | free association (#associations) |
| Inventor | precuneus | vivid, concrete material: images, scenarios, analogies, twists (#sparks) |
| Curator | right prefrontal | keeps the useful associations and sparks, with reasons (#ideas) |
| Logician | left parietal | maths and logic checks (#logic) |
| Coordinator | left hippocampus | **only writer** of the notebook: tasks, decisions, questions |
| Recall | right hippocampus | brings up long-term memories; **only writer** of long-term memory |
| Drafter | left prefrontal | **only writer** of the versioned draft |
| Storyteller | right inferior frontal gyrus | how the answer should be told: hook, order, example, tone (#telling) |
| Critic | anterior cingulate | questions the draft (#critique) |
| Motivator | striatum | reports interest, which drives the energy level |
| Inhibitor | orbitofrontal | approves or sends the final draft back |
| Voice | Broca's area | speaks the reply on the output channel |

* **Cycles and attention.** Each cycle, the voices with unread input are ranked by salience (DMs over board posts) and the top `max_turns` get the floor. They think side by side, up to the parallelism set in Settings.
* **Stopping.** Energy decays every cycle, fresh ideas bump it a little, and the Motivator's interest pulls it up or down. The thinking phase ends when energy falls below the threshold, when nobody has anything left to read ("quiet"), or at the cycle or time cap.
* **Wrap-up.** The Drafter hears "time is nearly up" and the cycles continue, but now only messages addressed to a voice wake it: board posts no longer do, so the voices that have had their say stay quiet instead of repeating themselves. The Drafter marks the draft *ready* when it considers it finished (or the Inhibitor steps in once nobody has anything left to say). A rejection goes back to the Drafter as a private message, together with the latest critique, so the Drafter weighs both instead of simply obeying the gate; then the cycles continue. It's bounded by `wrap_cycles` and `max_rejections`. Then the Voice speaks and Recall stores what's worth remembering.
* **Edit-based drafting.** After the first version, the Drafter changes the draft with edits (find a passage, replace it) plus a one-line note on what it changed and why. Each version records its edits, a word-level diff, and everything the Drafter had just read, so the draft panel shows which input caused which change. Edits whose passage can't be found, or whose replacement is abbreviated with "...", are refused and reported back to the Drafter.
* **Echo control.** Silence is the default, voices have cooldowns, and near-duplicate posts are dropped.
* **Information hiding.** Each voice gets a JSON schema built from its own permissions, and its output is clamped to them: it can't post to boards it doesn't own, DM strangers, or write memory it doesn't own.

## Configure

* `src/config/agents.yaml`: voices, personas, models (OpenRouter ids), boards, contacts, memory grants, abilities, region position/colour, plus cycle and energy settings. Adding a voice needs no code.
* `src/config/profiles/*.yaml`: model assignments. `diverse` gives each voice a model from a different family (Qwen, Granite, Mistral, Phi, Gemma); `dirksdefault` keeps the best performers from the first runs (Logician on GLM 5.3 Flash with thinking, Storyteller and Inhibitor on Gemma 4 26B), puts the voices that judge others' work on a different family than the work they judge (Critic and Curator on GLM 5.3 Flash), and every other voice on Gemini 3.8 Flash; `fast` puts every voice on `google/gemini-2.5-flash-lite`; `in-browser` runs every voice on a small model in your browser (see below).
* **In the UI:** hover a voice on the brain for its card (task, configuration, current state); click it, or use "Configure voices", to open the voice editor: model (every OpenRouter model that supports enforced JSON output, with prices), temperature, thinking, on/off and persona. Saving creates a custom profile in this browser; the built-in profiles can't be overwritten.

## In-browser model (opt-in, no key)

The `in-browser` profile runs every voice on one small model on your own graphics card with [WebLLM](https://github.com/mlc-ai/web-llm) (WebGPU; recent Chrome or Edge). Default: Qwen3.5 2B (about 1.5 GB, downloaded once from Hugging Face and cached). The voice editor offers a few others (Qwen3.5 4B, Qwen3 1.7B, Llama 3.2 3B, Gemma 4 E2B), and you can mix them with hosted voices. It is an imperfect stand-in: roughly 20 tokens a second on a mid-range GPU, so turns are kept short and a session takes several minutes, and small models make reasoning mistakes the hosted ones don't. Without a key, Recall falls back to word matching and the reply is spoken by Kokoro in the browser.

## Example prompts and sessions

* **✦ example prompts** above the input box fills in a question to try (trick questions, science, a story, ideas, philosophy).
* **⤓** next to a session exports it as a file: its events, spoken audio and the memories it left. **import…** adds such a file, from this or another browser.
* **Demo sessions** ship in `public/demos/`: five real runs (the two-hours-of-sleep question, weekend ideas, the heavy stone, sky and sunsets, the bat and the ball), with their spoken audio as MP3. They are imported on first load (labelled "demo"), along with the memories they left for Recall, so the app can be shown without any key; replays play the recorded voice. To add more, export a session with ⤓ and list the file in `public/demos/index.json`.

## The key and your data

* **The OpenRouter key lives in your browser**: in local storage, or only for the tab if you untick "remember". It goes only to OpenRouter.
* **Privacy:** everything a voice reads (the question, notes, the draft) goes to OpenRouter and the model's provider, and so does the reply's text when it is spoken by an OpenRouter speech model.
* **Stored in this browser (IndexedDB):** every session as an event log (the UI replays from it), long-term memories (with OpenRouter embeddings, `openai/text-embedding-3-small`), saved profiles and the spoken audio. **⚙ Settings → forget everything** deletes it all. Sessions cut off by closing the page are marked "interrupted".

## Spoken reply

The Voice's reply is spoken, chunk by chunk, so playback starts while the rest is still being made; Broca's area pulses with the voice. Set it up in **⚙ Settings**:

* **OpenRouter speech model** (default): `google/gemini-3.8-flash-tts`, or any of OpenRouter's text-to-speech models (ElevenLabs, MiniMax, Microsoft MAI, Fish Audio, …), each with its own voices. A free-text **speaking style** ("dry and deadpan", "breathless excitement") is passed as delivery instructions; Gemini and a few others follow it. Up to three chunks are made in parallel.
* **Kokoro, in this browser** (offline option): the same small model as the server version, run in a web worker. About 90 MB downloads from Hugging Face on first use. In a browser it is much slower than real time, so long replies pause between chunks.
* The audio is stored with the session, so replays speak too; older sessions can be spoken on demand ("▶ hear it"). Changing voice, model or style makes new audio instead of replaying the old.

## Tests

```bash
npm test
```

The tests use a scripted fake model, a fake OpenRouter and an in-memory IndexedDB, so they need no network. They include a check that the TypeScript port of Python's `difflib` (used for echo detection, fuzzy edits and diffs) gives exactly Python's results.

## License

MIT, see [LICENSE](LICENSE).
