import { log } from "../logger.js";

export interface SignInCodeEmail {
  to: string;
  code: string;
}

/** Sends sign-in codes. Resend in production; tests capture codes instead. */
export interface Mailer {
  sendSignInCode(mail: SignInCodeEmail): Promise<void>;
}

const formatCode = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;

export function signInCodeMessage({ code }: SignInCodeEmail) {
  return {
    subject: `Your Keel code: ${formatCode(code)}`,
    text: `Your Keel sign-in code is ${formatCode(code)}\n\nIt expires in 10 minutes. If you didn't ask for it, you can ignore this email.\n`,
    html: `<p>Your Keel sign-in code is</p><p style="font:600 28px ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:4px">${formatCode(code)}</p><p>It expires in 10 minutes. If you didn't ask for it, you can ignore this email.</p>`,
  };
}

/** Resend's REST API (https://resend.com/docs/api-reference/emails/send-email). */
export class ResendMailer implements Mailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
  ) {}

  async sendSignInCode(mail: SignInCodeEmail) {
    const msg = signInCodeMessage(mail);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [mail.to], ...msg }),
    });
    if (!res.ok) throw new Error(`Resend answered ${res.status}`);
  }
}

/** Local development only: prints the code to the server log instead of emailing it. */
export const consoleMailer: Mailer = {
  async sendSignInCode({ to, code }) {
    log.warn("dev_sign_in_code", { to, code });
  },
};

/** Production without an email key: email sign-in answers 503 rather than printing codes. */
export const disabledMailer: Mailer = {
  async sendSignInCode() {
    throw new Error("email is not configured");
  },
};
