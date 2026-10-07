/**
 * The ONE streaming speech session in the dashboard, and the ONLY file allowed
 * to import the Azure Speech SDK (pinned by backend/test/voiceMediaGuard.test.js).
 *
 * Two pages use it: the voice lab (item 34, where it was born) and the perio
 * sheet's voice entry (item 35). Neither imports the SDK itself, so there is one
 * place to read to know what the dashboard asks Azure for.
 *
 * Browser → Azure directly, with a 10-minute authorization token the CareIN
 * backend minted. Audio never touches the CareIN backend or any disk: the SDK
 * reads the default microphone and streams it to Azure's real-time endpoint,
 * and the recognised text comes back to the calling page's memory only.
 *
 * NOTHING HERE TURNS ON AZURE-SIDE RETENTION. Real-time recognition retains
 * nothing by default; what would change that is the SDK's audio-logging switch,
 * a custom-model endpoint, or a service property asking for storage. None of
 * those is named in this file, and the guard test fails the build if one ever
 * is. SDK telemetry is switched off as well.
 *
 * Load it LAZILY (`await import(...)`) from a page: the SDK is large, and a
 * dynamic import keeps it out of every bundle that never arms a microphone.
 *
 * ITEM 37: DETAILED OUTPUT, FOR THE LEXICAL FORM. The display text is Azure's
 * inverse-text-normalized rendering ("Jump to 2:30", "Jump back to tooth 3,
 * mesial, buccal") — right for a human to read, wrong for a parser. With the
 * output format set to Detailed, the SDK (1.52.0) parses each FINAL's service
 * JSON into an NBest list, sets `result.text` to `NBest[0].Display`, and leaves
 * the whole JSON on `result.json`, where `NBest[0].Lexical` holds the spoken
 * words before normalization ("jump to tooth thirty"). PARTIALS carry no NBest
 * in either format (the SDK builds them from a hypothesis that has only `Text`),
 * so a partial's `lexical` is always null. Detailed output changes what comes
 * BACK; it asks Azure to keep nothing.
 */
import {
  AudioConfig,
  OutputFormat,
  PhraseListGrammar,
  PropertyId,
  Recognizer,
  ResultReason,
  SpeechConfig,
  SpeechRecognizer,
} from "microsoft-cognitiveservices-speech-sdk";

export interface RecognizedSpeech {
  /** The DISPLAY text as Azure returned it — what a person is shown. Lives in page memory only. */
  text: string;
  /**
   * ITEM 37: the LEXICAL text (the spoken words, before inverse text
   * normalization) — what a parser should read. Null when the result carries
   * none: every partial, and any final whose JSON has no NBest lexical form.
   */
  lexical: string | null;
  /** performance.now() when the event reached the page. */
  atMs: number;
  /** Audio position of the utterance, 100 ns ticks from stream start. */
  offsetTicks: number;
  durationTicks: number;
  /** Finals only: the SDK's end-of-speech → result latency, if reported. */
  sdkLatencyMs: number | null;
}

export interface SpeechSessionHandlers {
  onPartial: (r: RecognizedSpeech) => void;
  onFinal: (r: RecognizedSpeech) => void;
  /** A cancellation or start failure. The message is Azure's, never audio or text. */
  onError: (message: string) => void;
}

export interface SpeechSession {
  /** performance.now() when recognition started — the fallback stream anchor. */
  streamStartMs: number;
  stop: () => Promise<void>;
}

/**
 * ITEM 37: `NBest[0].Lexical` out of a result's JSON, or null. NBest[0] is the
 * entry `result.text` is the Display of, so the two forms are one hypothesis.
 */
export function lexicalFromResultJson(json: string | undefined): string | null {
  if (!json) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const nbest: unknown = (parsed as { NBest?: unknown }).NBest;
  if (!Array.isArray(nbest) || nbest.length === 0) return null;
  const first: unknown = nbest[0];
  if (typeof first !== "object" || first === null) return null;
  const lexical: unknown = (first as { Lexical?: unknown }).Lexical;
  return typeof lexical === "string" ? lexical : null;
}

/**
 * Start continuous recognition from the default microphone.
 *
 * @param phrases the phrase list — the vocabulary the calling page listens for
 */
export function startSpeechSession(
  token: string,
  region: string,
  phrases: readonly string[],
  handlers: SpeechSessionHandlers,
): Promise<SpeechSession> {
  Recognizer.enableTelemetry(false);

  const speechConfig = SpeechConfig.fromAuthorizationToken(token, region);
  speechConfig.speechRecognitionLanguage = "en-US";
  // ITEM 37: NBest with the Lexical form on every final (see the header).
  speechConfig.outputFormat = OutputFormat.Detailed;
  const audioConfig = AudioConfig.fromDefaultMicrophoneInput();
  const recognizer = new SpeechRecognizer(speechConfig, audioConfig);

  const phraseList = PhraseListGrammar.fromRecognizer(recognizer);
  phraseList.addPhrases([...phrases]);

  recognizer.recognizing = (_sender, e) => {
    handlers.onPartial({
      text: e.result.text ?? "",
      // A hypothesis has no NBest; read it anyway, so a future SDK that adds one is used.
      lexical: lexicalFromResultJson(e.result.json),
      atMs: performance.now(),
      offsetTicks: e.result.offset,
      durationTicks: e.result.duration,
      sdkLatencyMs: null,
    });
  };

  recognizer.recognized = (_sender, e) => {
    const atMs = performance.now();
    if (e.result.reason !== ResultReason.RecognizedSpeech && e.result.reason !== ResultReason.NoMatch) return;
    const rawLatency = e.result.properties?.getProperty(PropertyId.SpeechServiceResponse_RecognitionLatencyMs);
    const latency = rawLatency === undefined || rawLatency === "" ? NaN : Number(rawLatency);
    const recognized = e.result.reason === ResultReason.RecognizedSpeech;
    handlers.onFinal({
      text: recognized ? (e.result.text ?? "") : "",
      lexical: recognized ? lexicalFromResultJson(e.result.json) : null,
      atMs,
      offsetTicks: e.result.offset,
      durationTicks: e.result.duration,
      sdkLatencyMs: Number.isFinite(latency) ? latency : null,
    });
  };

  recognizer.canceled = (_sender, e) => {
    handlers.onError(e.errorDetails || "Recognition was cancelled.");
  };

  let closed = false;
  const close = (): Promise<void> =>
    new Promise<void>((resolve) => {
      if (closed) return resolve();
      closed = true;
      const finish = () => {
        recognizer.close();
        audioConfig.close();
        resolve();
      };
      recognizer.stopContinuousRecognitionAsync(finish, finish);
    });

  return new Promise<SpeechSession>((resolve, reject) => {
    const streamStartMs = performance.now();
    recognizer.startContinuousRecognitionAsync(
      () => resolve({ streamStartMs, stop: close }),
      (err: string) => {
        void close();
        reject(new Error(err || "Could not start recognition."));
      },
    );
  });
}
