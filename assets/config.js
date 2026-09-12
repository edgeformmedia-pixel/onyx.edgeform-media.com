/* ONYX CRM — front-end config.
   This file is committed to a public repo, so it holds no secrets.
   The Resend and OpenAI keys live only in the Cloudflare Worker. */

window.ONYX_CONFIG = {
  SHEET_URL: 'https://onyx-crm.edgeformmedia.workers.dev/',
  SHEET_SECRET: 'test',                 // protected by the ONYX CRM Worker
  WORKER_URL: 'https://email.edgeformmedia.workers.dev/',
  WORKER_SECRET: 'test',                // must match ONYX_SECRET in the Worker
  CAMPAIGN_WORKER_URL: 'https://onyx-campaigns.edgeformmedia.workers.dev/',
  // The verified Resend domain. The campaign composer appends this to the
  // local sender name a rep enters (for example, sales@onyxmedicalgroups.com).
  SEND_DOMAIN: 'onyxmedicalgroups.com',
  FROM_OPTIONS: ['customerrelations', 'sales', 'info'],
  POSTAL_ADDRESS: '',
  UNSUBSCRIBE_LINE: 'Not the right fit? Reply STOP and I will not contact you again.'
};

window.ONYX_TEMPLATES = [
  {
    name: 'Cold outreach — call opener',
    subject: '{{business}} — one quick idea',
    body: 'Hi {{firstName}},\n\n' +
      'I had a quick idea for {{business}}.\n\n' +
      'We help med spas add laser hair removal and tattoo removal with an Onyx system, training included, without tying up the entire cash purchase on day one.\n\n' +
      'If it looks relevant, I can send the pricing and simple break-even numbers. Would it be unreasonable for me to call you this week and walk you through it?\n\n' +
      '{{myName}}\nOnyx Medical Groups'
  },
  {
    name: 'Test outreach — follow-up',
    subject: 'Following up — {{business}}',
    body: 'Hi {{firstName}},\n\n' +
      'Just checking back on my note. If someone else is a better contact, I would appreciate a quick introduction.\n\n' +
      'Thank you,\n{{myName}}\nOnyx Medical Groups'
  }
];
