export function escapeUnicode(character: string): string {
	const codePoint = character.codePointAt(0);
	if (codePoint === undefined) return "";
	if (codePoint <= 0xffff)
		return `\\u${codePoint.toString(16).padStart(4, "0")}`;
	const offset = codePoint - 0x10000;
	const high = 0xd800 + (offset >> 10);
	const low = 0xdc00 + (offset & 0x3ff);
	return `\\u${high.toString(16)}\\u${low.toString(16)}`;
}

/** JSON-encode with invisible and line-separator characters escaped. */
export function safeJson(value: unknown, space?: number): string {
	const encoded = JSON.stringify(value, null, space);
	if (encoded === undefined) throw new Error("value is not JSON serializable");
	return encoded.replace(/[\u007f-\u009f\u2028\u2029]|\p{Cf}/gu, escapeUnicode);
}
