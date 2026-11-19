export type A2aLanguage = "en" | "zh";

/** Pick the UI language from A2A_LANG, then the POSIX locale variables. */
export function detectA2aLanguage(
	env: Record<string, string | undefined> = process.env,
): A2aLanguage {
	const locale =
		env.A2A_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
	return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}
