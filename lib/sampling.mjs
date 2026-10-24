/**
 * sampling.mjs — the sampling parameters every automated evaluator sends.
 *
 * The A-H evaluation is a judgement, and a judgement sampled at temperature
 * 0.4 moved the Global score by 0.4 between identical runs of one posting.
 * Temperature 0 and a fixed seed remove the part of that spread the provider
 * lets us remove; what remains is model noise, which docs/JEV.md describes,
 * and the Jev segment is the number that stays put between runs.
 *
 * OpenAI-compatible endpoints read `temperature` and `seed`; Gemini reads
 * `generationConfig.temperature` and `generationConfig.seed`; Ollama reads
 * `options.temperature` and `options.seed`. Providers that ignore `seed`
 * accept it silently. `claude -p` exposes neither, so the interactive and
 * web paths rely on the Jev segment and the Scoring note alone.
 */

export const SAMPLING_TEMPERATURE = 0;
export const SAMPLING_SEED = 42;
