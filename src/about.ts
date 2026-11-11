// "What is this?": a short explanation of the project, opened from the top bar.

const TEXT = `
<p class="about-lead">Norbert, the brain, answers a question the way a crowd of voices in a head might: small, narrow
minds talk it through until one of them says the answer. You watch the whole conversation as it happens.</p>

<h3>What happens</h3>
<p>A question pops up. About a dozen voices, each with one job and one model behind it, react on shared
notice boards and in private messages: one pins down what is really being asked, one free-associates,
one invents images and analogies, one does the maths, one writes the draft, one criticises it, one
thinks about how to tell it, one keeps the notebook, one remembers earlier sessions. A drive level
falls as the work settles; then the writer finishes, a gatekeeper approves or sends the draft back, and
one voice speaks the reply. None of them knows it is part of a brain; each sees only its own boards,
its messages and what it is allowed to read.</p>

<h3>Why a conversation</h3>
<p>The point is explainability. Every answer comes with a trace you can follow: who said what, which note
changed which sentence of the draft, why the gate objected. Unlike the "thinking" text of reasoning
models, this trace is not a monologue generated alongside the answer that may or may not reflect how the
answer came about. It is the actual exchange the answer was built from: change a voice, and the
conversation, and the answer, change with it.</p>

<h3>Where it comes from</h3>
<p>Norbert, the brain, revisits the MSc dissertation of <a href="https://primbs.ca/" target="_blank" rel="noopener">Dirk Primbs</a>.
It built a pipeline of
specialised small models whose explicit trace acts as a functional analogue of human inner speech, and
found that it made the process far more transparent than direct answers or chain-of-thought. A real
dialogue between independent agents was the original idea, set aside because small local models could
not hold it together. This is that idea, done playfully and with stronger models: the same principle of
limited, focused entities collaborating, now as an open conversation.</p>

<h3>How to watch</h3>
<p>Ask something or pick an <b>✦ example prompt</b>, or replay a <b>demo</b> session (no key needed).
Hover a voice on the brain to see its job and state, click it to change its model or persona, filter
the stream by voice or group, and open the draft panel to see each version, what changed and why.</p>

<p class="about-source">The source code is open: <a href="https://github.com/dirkprimbs/tankbrain-web" target="_blank"
rel="noopener">github.com/dirkprimbs/tankbrain-web</a></p>
`;

export class AboutWindow {
  private root = document.createElement("div");

  constructor() {
    this.root.className = "editor-backdrop";
    const panel = document.createElement("div");
    panel.className = "editor settings about";
    panel.innerHTML = `<div class="editor-head"><h2>WHAT IS THIS?</h2><button class="ghost">×</button></div>
      <div class="settings-body about-body">${TEXT}</div>`;
    panel.querySelector(".editor-head button")!.addEventListener("click", () => this.close());
    this.root.append(panel);
    this.root.addEventListener("mousedown", (e) => { if (e.target === this.root) this.close(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape") this.close(); });
    document.body.append(this.root);
  }

  open() {
    this.root.classList.add("show");
  }

  close() {
    this.root.classList.remove("show");
  }
}
