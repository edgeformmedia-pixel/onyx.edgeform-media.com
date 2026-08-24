/* ONYX CRM — front-end configuration.
   Safe to commit: there are no secrets here. The Resend and OpenAI
   keys live only in the Cloudflare Worker's environment variables.

   Fill these two in, or leave blank and set them in the Admin tab
   (they're saved per browser in localStorage). */

window.ONYX_DEFAULTS = {
  SHEET_URL: '',        // https://script.google.com/macros/s/AKfyc.../exec
  SHEET_SECRET: '',     // must match SHARED_SECRET in Code.gs
  WORKER_URL: 'https://email.edgeformmedia.workers.dev/',
  WORKER_SECRET: '',    // must match ONYX_SECRET in the Worker
  SEND_DOMAIN: 'edgeform-media.com',

  // Local part of the From address. The Worker rebuilds the full
  // address itself, so nobody can spoof an arbitrary sender.
  FROM_OPTIONS: ['email', 'sales', 'info', 'thomas'],

  POSTAL_ADDRESS: '',
  UNSUBSCRIBE_LINE: 'Not the right fit? Reply STOP and I will not contact you again.'
};

window.ONYX_TEMPLATES = [
  {
    name: 'Cold — adds tattoo removal',
    subject: 'Adding tattoo removal at {{business}}?',
    body:
`Hi {{firstName}},

I saw {{business}} offers laser hair removal but I didn't see tattoo removal on your service list.

We place Onyx aesthetic laser systems with med spas around {{city}}. The machines run about $30,000, structured as $10,000 down with the rest financed, and most operators cover the payment with a handful of treatments a month.

Worth a short call to see whether the numbers work for your patient volume?

{{myName}}
Edgeform Media`
  },
  {
    name: 'Cold — expanding / new location',
    subject: 'Equipment for the new {{city}} location',
    body:
`Hi {{firstName}},

Congratulations on the expansion at {{business}}.

If you're speccing equipment for the new space, we supply Onyx laser hair removal and tattoo removal systems. Roughly $30,000, $10,000 down and the balance financed, so it doesn't tie up the build-out budget.

Happy to send specs and treatment-margin numbers if useful.

{{myName}}
Edgeform Media`
  },
  {
    name: 'Follow-up — no reply',
    subject: 'Following up — {{business}}',
    body:
`Hi {{firstName}},

Circling back on my note about adding a laser to {{business}}.

If the timing is wrong, tell me when to check back and I'll leave you alone until then.

{{myName}}
Edgeform Media`
  },
  {
    name: 'After a call — send specs',
    subject: 'Specs from our call',
    body:
`Hi {{firstName}},

Good speaking with you. As promised, here are the details on the Onyx system:

- Laser hair removal and tattoo removal in one platform
- About $30,000, with $10,000 down and the balance financed
- Training and setup included

Let me know what questions come up and we'll get you a demo scheduled.

{{myName}}
Edgeform Media`
  }
];
