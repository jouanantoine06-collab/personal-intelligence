import { describe, expect, it } from "vitest";
import { parseJsonResponse } from "@/core/ai-provider/parse-json-response";

describe("parseJsonResponse — bug réel observé avec Haiku (balises markdown non respectées)", () => {
  it("parse un JSON brut", () => {
    expect(parseJsonResponse('{"a":1}')).toEqual({ a: 1 });
  });

  it("parse un JSON encapsulé dans ```json ... ```", () => {
    expect(parseJsonResponse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("parse un JSON encapsulé dans ``` ... ``` sans langage", () => {
    expect(parseJsonResponse('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  it("lève une erreur pour un contenu réellement invalide", () => {
    expect(() => parseJsonResponse("pas du JSON")).toThrow();
  });
});
