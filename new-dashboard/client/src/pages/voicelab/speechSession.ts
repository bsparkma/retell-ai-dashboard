/**
 * The voice lab's streaming session — the ONLY file in the dashboard allowed to
 * import the Azure Speech SDK (pinned by backend/test/voiceMediaGuard.test.js).
 *
 * Browser → Azure directly, with a 10-minute authorization token the CareIN
 * backend minted. Audio never touches the CareIN backend or any disk: the SDK
 * reads the default microphone and streams it to Azure's real-time endpoint,
 * and the recognised text comes back to this page's memory only.
 *
 * NOTHING HERE TURNS ON AZURE-SIDE RETENTION. Real-time recognition retains
 * nothing by default; what would change that is the SDK's audio-logging switch,
 * a custom-model endpoint, or a service property asking for storage. None of
 * those is named in this file, and the guard test fails the build if one ever
 * is. SDK telemetry is switched off as well.
 */
import {
  AudioConfig,
  PhraseListGrammar,
  PropertyId,
  Recognizer,
  ResultReason,
  SpeechConfig,
  SpeechRecognizer,
} from "microsoft-cognitiveservices-speech-sdk";

export interface LabRecognition {
  /** Raw text as Azure returned it. Lives in page memory only. */
  text: string;
  /** performance.now() when the event reached the page. */
  atMs: number;
  /** Audio position of the utterance, 100 ns ticks from stream start. */
  offsetTicks: number;
  durationTicks: number;
  /** Finals only: the SDK's end-of-speech → result latency, if reported. */
  sdkLatencyMs: number | null;
}

export interface LabSessionHandlers {
  onPartial: (r: LabRecognition) => void;
  onFinal: (r: LabRecognition) => void;
  /** A cancellation or start failure. The message is Azure's, never audio or text. */
  onError: (message: string) => void;
}

export interface LabSession {
  /** performance.now() when recognition started — the fallback stream anchor. */
  streamStartMs: number;
  stop: () => Promise<void>;
}

/**
 * Start continuous recognition from the default microphone.
 *
 * @param phrases the phrase list (digit words + perio findings)
 */
export function startLabSession(
  token: string,
  region: string,
  phrases: readonly string[],
  handlers: LabSessionHandlers,
): Promise<LabSession> {
  Recognizer.enableTelemetry(false);

  const speechConfig = SpeechConfig.fromAuthorizationToken(token, region);
  speechConfig.speechRecognitionLanguage = "en-US";
  const audioConfig = AudioConfig.fromDefaultMicrophoneInput();
  const recognizer = new SpeechRecognizer(speechConfig, audioConfig);

  const phraseList = PhraseListGrammar.fromRecognizer(recognizer);
  phraseList.addPhrases([...phrases]);

  recognizer.recognizing = (_sender, e) => {
    handlers.onPartial({
      text: e.result.text ?? "",
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
    handlers.onFinal({
      text: e.result.reason === ResultReason.RecognizedSpeech ? (e.result.text ?? "") : "",
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

  return new Promise<LabSession>((resolve, reject) => {
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
