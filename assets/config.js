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
  FROM_OPTIONS: ['customerrelations', 'sales', 'info', 'team'],
  POSTAL_ADDRESS: '',
  UNSUBSCRIBE_LINE: 'Not the right fit? Reply STOP and I will not contact you again.'
};

window.ONYX_TEMPLATES = [
  {
    name: 'First outreach — call setup',
    subject: '{{business}} — quick question',
    body: 'Hi {{firstName}},\n\n' +
      'I had a quick idea for {{business}}.\n\n' +
      'We help med spas add laser hair removal and tattoo removal with an Onyx system, hands-on training, and launch support — without tying up the full cash purchase on day one.\n\n' +
      'I can send over the pricing and a simple break-even estimate for {{business}}. If the numbers look relevant, I’ll give you a quick call later this week to walk through it.\n\n' +
      'Would that be unreasonable?\n\n' +
      'Best,\n{{myName}}\nOnyx Medical Groups'
  },
  {
    name: 'Follow-up — no response',
    subject: 'Re: {{business}} — quick question',
    body: 'Hi {{firstName}},\n\n' +
      'Wanted to make sure my note about adding laser hair removal and tattoo removal at {{business}} reached you.\n\n' +
      'I’m happy to send the pricing and break-even estimate first so you can decide if a conversation is worthwhile. If someone else handles new services, who would be the best person to speak with?\n\n' +
      'Best,\n{{myName}}\nOnyx Medical Groups'
  },
  {
    name: 'Direct — send the numbers',
    subject: 'Numbers for {{business}}',
    body: 'Hi {{firstName}},\n\n' +
      'I’m reaching out because {{business}} looks like a strong fit for an Onyx system.\n\n' +
      'We provide the equipment, hands-on training, and launch support for laser hair removal and tattoo removal without requiring the full purchase price up front.\n\n' +
      'Would you like me to send a one-page pricing and break-even estimate before I call?\n\n' +
      'Best,\n{{myName}}\nOnyx Medical Groups'
  }
];
