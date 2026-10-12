/**
 * THE SHARED SPEECH SESSION SURFACES LEXICAL TEXT (item 37).
 *
 * The Speech SDK is mocked at its module boundary, so this drives the REAL
 * lib/speech/speechSession.ts: it must ask for Detailed output, hand every
 * final's NBest[0].Lexical to the page beside the display text, and give null
 * — never a guess — where the result carries no lexical form (every partial,
 * a final with no NBest, a NoMatch).
 *
 * The result JSON below is the shape SDK 1.52.0 builds for a Detailed final
 * (DetailedSpeechPhrase: RecognitionStatus, NBest[{ Lexical, ITN, MaskedITN,
 * Display }], DisplayText). The words are synthetic perio commands.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  recognizer: null as null | {
    recognizing?: (sender: unknown, e: unknown) => void;
    recognized?: (sender: unknown, e: unknown) => void;
    canceled?: (sender: unknown, e: unknown) => void;
  },
  speechConfig: null as null | Record<string, unknown>,
}));

vi.mock("microsoft-cognitiveservices-speech-sdk", () => {
  const OutputFormat = { Simple: 0, Detailed: 1 } as const;
  const ResultReason = { NoMatch: 0, RecognizingSpeech: 2, RecognizedSpeech: 3 } as const;
  class SpeechRecognizer {
    recognizing?: (sender: unknown, e: unknown) => void;
    recognized?: (sender: unknown, e: unknown) => void;
    canceled?: (sender: unknown, e: unknown) => void;
    constructor() {
      sdk.recognizer = this;
    }
    startContinuousRecognitionAsync(ok: () => void) {
      ok();
    }
    stopContinuousRecognitionAsync(ok: () => void) {
      ok();
    }
    close() {}
  }
  return {
    OutputFormat,
    ResultReason,
    PropertyId: { SpeechServiceResponse_RecognitionLatencyMs: 9999 },
    Recognizer: { enableTelemetry: vi.fn() },
    SpeechConfig: {
      fromAuthorizationToken: vi.fn(() => {
        const config: Record<string, unknown> = {};
        sdk.speechConfig = config;
        return config;
      }),
    },
    AudioConfig: { fromDefaultMicrophoneInput: vi.fn(() => ({ close: vi.fn() })) },
    PhraseListGrammar: { fromRecognizer: vi.fn(() => ({ addPhrases: vi.fn() })) },
    SpeechRecognizer,
  };
});

import { lexicalFromResultJson, startSpeechSession, type RecognizedSpeech } from "@/lib/speech/speechSession";

function detailedJson(display: string, lexical: string): string {
  return JSON.stringify({
    RecognitionStatus: "Success",
    Offset: 0,
    Duration: 10_000_000,
    DisplayText: display,
    NBest: [
      { Confidence: 0.9, Lexical: lexical, ITN: display, MaskedITN: display, Display: display },
      { Confidence: 0.4, Lexical: "a second guess", ITN: "x", MaskedITN: "x", Display: "x" },
    ],
  });
}

function event(reason: number, text: string, json: string | undefined) {
  return {
    result: {
      reason,
      text,
      json,
      offset: 1,
      duration: 2,
      properties: { getProperty: () => "" },
    },
  };
}

let partials: RecognizedSpeech[];
let finals: RecognizedSpeech[];

beforeEach(async () => {
  partials = [];
  finals = [];
  sdk.recognizer = null;
  sdk.speechConfig = null;
  await startSpeechSession("tok", "southcentralus", ["jump to tooth"], {
    onPartial: (r) => partials.push(r),
    onFinal: (r) => finals.push(r),
    onError: () => {},
  });
});

describe("item 37: the shared session asks for, and surfaces, the lexical form", () => {
  it("sets the output format to Detailed", () => {
    expect(sdk.speechConfig?.outputFormat).toBe(1);
  });

  it("a final carries NBest[0].Lexical beside the display text", () => {
    sdk.recognizer?.recognized?.(null, event(3, "Jump to 2:30.", detailedJson("Jump to 2:30.", "jump to two thirty")));
    expect(finals).toHaveLength(1);
    expect(finals[0].text).toBe("Jump to 2:30.");
    expect(finals[0].lexical).toBe("jump to two thirty");
  });

  it("a final with no NBest (Simple-shaped JSON) or unreadable JSON gives lexical null — the page falls back to display", () => {
    sdk.recognizer?.recognized?.(
      null,
      event(3, "Jump to tooth 14.", JSON.stringify({ RecognitionStatus: "Success", DisplayText: "Jump to tooth 14." })),
    );
    sdk.recognizer?.recognized?.(null, event(3, "Jump to tooth 14.", "{not json"));
    sdk.recognizer?.recognized?.(null, event(3, "Jump to tooth 14.", undefined));
    expect(finals.map((f) => f.lexical)).toEqual([null, null, null]);
    expect(finals.map((f) => f.text)).toEqual(["Jump to tooth 14.", "Jump to tooth 14.", "Jump to tooth 14."]);
  });

  it("a NoMatch final is empty text and null lexical", () => {
    sdk.recognizer?.recognized?.(null, event(0, "", detailedJson("x", "x")));
    expect(finals).toEqual([expect.objectContaining({ text: "", lexical: null })]);
  });

  it("a partial carries no NBest from the SDK, so its lexical is null", () => {
    sdk.recognizer?.recognizing?.(null, event(2, "jump to 2", JSON.stringify({ Text: "jump to 2", Offset: 0, Duration: 1 })));
    expect(partials).toEqual([expect.objectContaining({ text: "jump to 2", lexical: null })]);
  });
});

describe("lexicalFromResultJson", () => {
  it("reads NBest[0].Lexical and nothing else", () => {
    expect(lexicalFromResultJson(detailedJson("Jump to tooth 5.", "jump to tooth five"))).toBe("jump to tooth five");
    expect(lexicalFromResultJson(JSON.stringify({ NBest: [] }))).toBeNull();
    expect(lexicalFromResultJson(JSON.stringify({ NBest: [{ Display: "x" }] }))).toBeNull();
    expect(lexicalFromResultJson(JSON.stringify({ NBest: [{ Lexical: 7 }] }))).toBeNull();
    expect(lexicalFromResultJson(JSON.stringify(null))).toBeNull();
    expect(lexicalFromResultJson("")).toBeNull();
  });
});
