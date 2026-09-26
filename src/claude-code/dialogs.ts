/**
 * Text for the elicitation dialogs shown to the local user. Claude Code
 * renders its own Accept/Decline buttons, so only the prose is localized.
 */
export type DialogLanguage = "en" | "zh";

export type DialogText = {
	approvalHeader: string[];
	to: string;
	attachments: string;
	everyone: string;
	rejectionPrompt: string;
	reasonTitle: string;
	reasonDescription: string;
	deleteProject: (name: string) => string;
};

const DIALOG_TEXT: Record<DialogLanguage, DialogText> = {
	en: {
		approvalHeader: [
			"Approve this A2A message? Accept sends it with your approval; Decline rejects it.",
			"(The full text is also in the tool call; press ctrl+o to expand.)",
		],
		to: "To",
		attachments: "Attachments",
		everyone: "Everyone in this Project",
		rejectionPrompt:
			"Message rejected; it will not be sent. To tell the agent why, type a reason and choose Accept (Accept only submits the reason). Decline discards anything typed here.",
		reasonTitle: "Rejection reason (optional)",
		reasonDescription: "Submitted only with Accept",
		deleteProject: (name) =>
			`Delete Project "${name}" and its entire message history? This cannot be undone.`,
	},
	zh: {
		approvalHeader: [
			"是否批准发送这条 A2A 消息？Accept = 签名并发送；Decline = 拒绝。",
			"（完整内容也在工具调用里，按 ctrl+o 展开。）",
		],
		to: "收件人",
		attachments: "附件",
		everyone: "本项目所有人",
		rejectionPrompt:
			"消息已拒绝，不会发送。如需告诉 agent 原因，请填写后按 Accept（这里的 Accept 只是提交理由）；按 Decline 会丢弃已填写的内容。",
		reasonTitle: "拒绝理由（选填）",
		reasonDescription: "仅在按 Accept 时提交",
		deleteProject: (name) =>
			`删除项目 "${name}" 及其全部消息历史？此操作不可撤销。`,
	},
};

/** Pick the dialog language from A2A_LANG, then the POSIX locale variables. */
export function detectDialogLanguage(
	env: Record<string, string | undefined> = process.env,
): DialogLanguage {
	const locale =
		env.A2A_LANG || env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
	return locale.toLowerCase().startsWith("zh") ? "zh" : "en";
}

export function dialogText(language: DialogLanguage): DialogText {
	return DIALOG_TEXT[language];
}
