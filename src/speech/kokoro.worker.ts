// Runs Kokoro (kokoro-js, ONNX) off the main thread. The model (~90 MB) and
// voices download from Hugging Face on first use and are cached by the browser.

import { KokoroTTS } from "kokoro-js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let tts: Promise<KokoroTTS> | null = null;

function load(): Promise<KokoroTTS> {
  if (!tts) {
    const gpu = "gpu" in navigator;
    tts = KokoroTTS.from_pretrained(MODEL, {
      // WebGPU needs the full-precision model (~330 MB); without it, the int8 one (~90 MB) on the CPU
      dtype: gpu ? "fp32" : "q8",
      device: gpu ? "webgpu" : "wasm",
      progress_callback: (p: any) => {
        if (p.status === "progress" && p.file?.endsWith(".onnx")) {
          postMessage({ type: "progress", loaded: p.loaded, total: p.total });
        }
      },
    });
    tts.catch(() => (tts = null)); // allow a retry after a failed download
  }
  return tts;
}

type Req = { id: number; type: "voices" } | { id: number; type: "synth"; text: string; voice: string; speed: number };

onmessage = async (ev: MessageEvent<Req>) => {
  const req = ev.data;
  try {
    const k = await load();
    if (req.type === "voices") {
      postMessage({ id: req.id, ok: true, voices: Object.keys(k.voices) });
    } else {
      const audio = await k.generate(req.text, { voice: req.voice as any, speed: req.speed });
      const samples = audio.audio as Float32Array;
      postMessage({ id: req.id, ok: true, samples, rate: audio.sampling_rate }, { transfer: [samples.buffer] });
    }
  } catch (e) {
    postMessage({ id: req.id, ok: false, error: String((e as Error)?.message ?? e) });
  }
};
