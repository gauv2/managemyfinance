/**
 * Censor mode's PIN — what stands between privacy mode and the amounts it hides.
 *
 * This is a shoulder-surfing guard, not security: the PIN sits in the plugin's settings file next to
 * everything else, and anyone with the vault can read the ledger directly. What it stops is the
 * thing privacy mode is for — someone at your desk, or a screen-share, clicking the eye and seeing it
 * all. Hiding amounts never asks for it; only revealing them does.
 */

export const DEFAULT_PRIVACY_PIN = "1234";
export const PIN_LENGTH = 4;

/** The PIN in force. Unset means the default; an empty string means you turned the prompt off. */
export function privacyPin(settings: { privacyPin?: string }): string {
	return settings.privacyPin ?? DEFAULT_PRIVACY_PIN;
}

export function isValidPin(pin: string): boolean {
	return new RegExp(`^\\d{${PIN_LENGTH}}$`).test(pin);
}

/** Whether revealing amounts needs the PIN pad at all. */
export function revealNeedsPin(settings: { privacyPin?: string }): boolean {
	return isValidPin(privacyPin(settings));
}
