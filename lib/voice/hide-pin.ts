/**
 * Display-only hiding of a spoken PIN. While an approval waits for the owner to say their PIN, the
 * on-screen transcript shows `[PIN hidden]` instead of digits. The server still receives the raw
 * words (it has to hear the PIN to check it) and stores the turn redacted; this only keeps the
 * digits off the screen. Mirrors `redactSpokenDigits` on the server.
 */
const WORDS = [
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "shunya",
  "ek",
  "do",
  "teen",
  "char",
  "chaar",
  "paanch",
  "panch",
  "chhe",
  "chah",
  "saat",
  "aath",
  "nau",
];
const DEVANAGARI = "०१२३४५६७८९";
const TOKEN = `(?:\\d+|[${DEVANAGARI}]+|\\b(?:${WORDS.join("|")})\\b)`;
const RUN = new RegExp(`${TOKEN}(?:[\\s,.\\-]+${TOKEN})*`, "gi");

export function hideSpokenDigits(text: string): string {
  return text.replace(RUN, (run) => {
    const digitCount = run
      .split(/[\s,.-]+/)
      .reduce(
        (total, token) => total + (WORDS.includes(token.toLowerCase()) ? 1 : token.length),
        0,
      );
    return digitCount >= 3 ? "[PIN hidden]" : run;
  });
}
