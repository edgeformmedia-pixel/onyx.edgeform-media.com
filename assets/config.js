/* ONYX CRM — front-end config.
   This file is committed to a public repo, so it holds no secrets.
   The Resend and OpenAI keys live only in the Cloudflare Worker. */

window.ONYX_CONFIG = {
  SHEET_URL: 'https://script.google.com/macros/s/AKfycbxok8UBe7P6VSKiOkTekAMIQgToGi5EEC66jxJmUUA90eYbIN3Qgi4UOiNKNkdNBF2Vbw/exec',
  SHEET_SECRET: 'change-me-to-a-long-random-string',                 // must match CONFIG.SHARED_SECRET in Code.gs
  WORKER_URL: 'https://email.edgeformmedia.workers.dev/',
  WORKER_SECRET: 'lasdgfiaugoiajbvfouahoeghaoieroayegvieuabeorgeaivrboauvbaoe8yrgboqevbeh',                // must match ONYX_SECRET in the Worker
  SEND_DOMAIN: 'edgeform-media.com',
  FROM_OPTIONS: ['email', 'sales', 'info'],
  POSTAL_ADDRESS: '',
  UNSUBSCRIBE_LINE: 'Not the right fit? Reply STOP and I will not contact you again.'
};

window.ONYX_TEMPLATES = [
  {
    name: 'Cold - adds tattoo removal',
    subject: 'Adding tattoo removal at {{business}}?',
    body: 'Hi {{firstName}},\n\n' +
      "I saw {{business}} offers laser hair removal but I didn't see tattoo removal on your service list.\n\n" +
      'We place Onyx aesthetic laser systems with med spas around {{city}}. The machines run about $30,000, ' +
      'structured as $10,000 down with the rest financed, and most operators cover the payment with a handful ' +
      'of treatments a month.\n\n' +
      'Worth a short call to see whether the numbers work for your patient volume?\n\n{{myName}}\nEdgeform Media'
  },
  {
    name: 'Cold - expanding / new location',
    subject: 'Equipment for the new {{city}} location',
    body: 'Hi {{firstName}},\n\n' +
      'Congratulations on the expansion at {{business}}.\n\n' +
      "If you're speccing equipment for the new space, we supply Onyx laser hair removal and tattoo removal " +
      "systems. Roughly $30,000, $10,000 down and the balance financed, so it doesn't tie up the build-out budget.\n\n" +
      'Happy to send specs and treatment-margin numbers if useful.\n\n{{myName}}\nEdgeform Media'
  },
  {
    name: 'Follow-up - no reply',
    subject: 'Following up - {{business}}',
    body: 'Hi {{firstName}},\n\n' +
      'Circling back on my note about adding a laser to {{business}}.\n\n' +
      "If the timing is wrong, tell me when to check back and I'll leave you alone until then.\n\n" +
      '{{myName}}\nEdgeform Media'
  },
  {
    name: 'After a call - send specs',
    subject: 'Specs from our call',
    body: 'Hi {{firstName}},\n\n' +
      'Good speaking with you. As promised, here are the details on the Onyx system:\n\n' +
      '- Laser hair removal and tattoo removal in one platform\n' +
      '- About $30,000, with $10,000 down and the balance financed\n' +
      '- Training and setup included\n\n' +
      "Let me know what questions come up and we'll get you a demo scheduled.\n\n{{myName}}\nEdgeform Media"
  }
];
