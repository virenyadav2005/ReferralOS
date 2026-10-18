export function createEmailProvider(config, { fetchImpl = fetch, logger = console } = {}) {
  const localPreviews = new Map();

  return {
    async sendWorkEmailVerification({ userId, to, link, expiresAt }) {
      if (config.emailProvider === 'console' && config.nodeEnv !== 'production') {
        // Keep the raw token out of logs and public API responses. The preview
        // is short-lived in memory and retrievable only by this local account.
        localPreviews.set(userId, { to, link, expiresAt });
        logger.info(`[ReferralOS development email preview] Verification preview is ready for ${to}. Open the employee dashboard on this local machine.`);
        return { status: 'development_preview' };
      }
      if (config.emailProvider === 'resend' && config.resendApiKey && config.emailFrom) {
        const response = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: { authorization: `Bearer ${config.resendApiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: config.emailFrom, to: [to], subject: 'Verify your ReferralOS work email',
            html: `<p>Verify your work email to continue setting up your ReferralOS employee profile.</p><p><a href="${link}">Verify work email</a></p><p>This link expires at ${new Date(expiresAt).toISOString()} and can be used once.</p>` }),
        });
        if (!response.ok) throw new Error('The email provider did not confirm delivery.');
        const result = await response.json().catch(() => ({}));
        if (!result.id) throw new Error('The email provider did not confirm delivery.');
        return { status: 'provider_accepted', providerId: result.id };
      }
      throw new Error('Email delivery is not configured. Set EMAIL_PROVIDER=resend, RESEND_API_KEY, and EMAIL_FROM.');
    },
    getLocalPreview(userId) {
      if (config.nodeEnv !== 'development') return null;
      const preview = localPreviews.get(userId);
      if (!preview || Date.parse(preview.expiresAt) <= Date.now()) {
        localPreviews.delete(userId);
        return null;
      }
      return preview;
    },
  };
}
