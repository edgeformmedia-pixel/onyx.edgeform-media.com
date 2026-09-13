// Seed copy for the "ONYX MG First Outreach" sequence, from the outreach docx.
// Two variants per step: 'first' = first laser for the practice,
// 'existing' = practice already offers laser hair removal.
// Editable later in the CRM (Campaigns → Edit emails); this only seeds a new database.

const SIGN_FULL = 'Best,\n{{repFirstName}}\nOnyx Medical Groups\nteam@onyxmedicalgroups.com\n{{repPhone}}';
const SIGN_SHORT = 'Best,\n{{repFirstName}}\nOnyx Medical Groups';

export const DEFAULT_SEQUENCE = {
  name: 'ONYX MG First Outreach',
  steps: [
    {
      stepNo: 1, name: 'Pain point', delayDays: 0,
      first: {
        subject: 'Quick question about {{business}}',
        body: 'Hi {{firstName}},\n\n' +
          'Quick question — has {{business}} looked at adding laser hair removal?\n\n' +
          'When a practice is considering its first laser, the concerns are usually the same: is there enough demand, how quickly can the team get trained, and will the machine actually generate enough revenue to justify the investment?\n\n' +
          'That’s where the Velor is different.\n\n' +
          'It combines triple-wavelength diode technology + integrated cooling with the infrastructure around the machine — including hands-on equipment training, applicable certification support, and a service-launch strategy designed to help practices actually monetize the treatment.\n\n' +
          'I can send you a short overview with pricing, acquisition options, and a simple break-even estimate based on your practice.\n\n' +
          'Would it be worth sending over?\n\n' + SIGN_FULL
      },
      existing: {
        subject: 'Quick question about {{business}}',
        body: 'Hi {{firstName}},\n\n' +
          'Quick question — how is laser hair removal performing at {{business}} right now?\n\n' +
          'For practices that already offer it, the conversation is usually about capacity, treatment efficiency, client comfort, and whether adding another device can increase revenue without simply adding more overhead.\n\n' +
          'That’s where the Velor is different.\n\n' +
          'Its triple-wavelength diode technology with integrated cooling is built for efficient, comfortable treatments — so a room can handle more volume — and it comes with hands-on equipment training and launch support for your team.\n\n' +
          'I can send you a short overview with pricing, acquisition options, and a simple estimate of what an upgraded or additional device could add for your practice.\n\n' +
          'Would it be worth sending over?\n\n' + SIGN_FULL
      }
    },
    {
      stepNo: 2, name: 'Value / economics', delayDays: 2,
      first: {
        subject: 'Re: Quick question about {{business}}',
        body: 'Hi {{firstName}},\n\n' +
          'Just following up on this.\n\n' +
          'One of the things we’re helping med spas evaluate is not simply which laser to buy, but whether the numbers make sense before they invest.\n\n' +
          'With Velor, we can map out things like:\n\n' +
          '• Approximate treatments needed to cover the monthly equipment cost\n' +
          '• Revenue potential at different treatment volumes\n' +
          '• Pricing strategy\n' +
          '• Training and certification requirements\n' +
          '• How to launch and market the service\n\n' +
          'So you can look at the business case first, rather than buying equipment and figuring it out afterward.\n\n' +
          'If you’d like, I can send over the Velor overview and a simple break-even model.\n\n' +
          'Worth a look?\n\n' + SIGN_SHORT
      },
      existing: {
        subject: 'Re: Quick question about {{business}}',
        body: 'Hi {{firstName}},\n\n' +
          'Just following up on this.\n\n' +
          'For practices already offering laser hair removal, the question usually isn’t whether the service works — it’s whether more capacity or better technology would pay for itself.\n\n' +
          'With Velor, we can map out things like:\n\n' +
          '• Revenue potential at higher treatment volumes\n' +
          '• Approximate treatments needed to cover the monthly equipment cost\n' +
          '• Whether it makes more sense as an upgrade or an additional treatment room\n' +
          '• Pricing and revenue per treatment room\n' +
          '• Training for your team on the new device\n\n' +
          'So you can look at the business case first, rather than adding equipment and figuring it out afterward.\n\n' +
          'If you’d like, I can send over the Velor overview and a simple break-even model.\n\n' +
          'Worth a look?\n\n' + SIGN_SHORT
      }
    },
    {
      stepNo: 3, name: 'Address the risk', delayDays: 3,
      first: {
        subject: 'Re: {{business}}',
        body: 'Hi {{firstName}},\n\n' +
          'One last thought.\n\n' +
          'We hear variations of the same concern from practice owners all the time:\n\n' +
          '“I don’t want an expensive machine sitting in a treatment room without generating enough revenue.”\n\n' +
          'That’s exactly why we don’t look at Velor as just an equipment sale.\n\n' +
          'The machine is paired with the Growth Package, which is built around helping the practice actually introduce and monetize the service:\n\n' +
          '• Hands-on equipment training — your team learns how to confidently operate Velor.\n' +
          '• Applicable certification support — for practices that need additional training/certification before offering the service.\n' +
          '• Service-launch strategy — support around positioning, pricing and introducing laser hair removal to your market.\n\n' +
          'Velor itself uses triple-wavelength diode technology with integrated cooling, but the technology is only part of the equation.\n\n' +
          'The objective is simple: put the machine in the treatment room and give the practice a realistic path toward making it profitable.\n\n' +
          'Want me to send the information over?\n\n' + SIGN_SHORT
      },
      existing: {
        subject: 'Re: {{business}}',
        body: 'Hi {{firstName}},\n\n' +
          'One last thought.\n\n' +
          'Practices that already offer laser hair removal tell us the same thing:\n\n' +
          '“I don’t want another expensive machine that just adds overhead.”\n\n' +
          'That’s exactly why we don’t look at Velor as just an equipment sale.\n\n' +
          'The machine is paired with the Growth Package, built around helping the practice grow the service:\n\n' +
          '• Hands-on equipment training — your team gets confident on Velor quickly.\n' +
          '• Service-launch strategy — support around positioning, pricing and filling the added capacity.\n' +
          '• Triple-wavelength diode technology with integrated cooling — built for client comfort and efficient treatments.\n\n' +
          'The objective is simple: add capacity and revenue per treatment room without adding dead weight.\n\n' +
          'Want me to send the information over?\n\n' + SIGN_SHORT
      }
    },
    {
      stepNo: 4, name: 'Breakup', delayDays: 5,
      first: {
        subject: 'Should I close this out?',
        body: 'Hi {{firstName}},\n\n' +
          'I haven’t heard back, so I don’t want to keep filling your inbox.\n\n' +
          'Should I close this out for now, or would you still like me to send over the Velor pricing and break-even information?\n\n' +
          'Either answer is completely fine.\n\n' +
          'Best,\n{{repFirstName}}'
      },
      existing: {
        subject: 'Should I close this out?',
        body: 'Hi {{firstName}},\n\n' +
          'I haven’t heard back, so I don’t want to keep filling your inbox.\n\n' +
          'Should I close this out for now, or would you still like me to send over the Velor pricing and break-even information?\n\n' +
          'Either answer is completely fine.\n\n' +
          'Best,\n{{repFirstName}}'
      }
    }
  ]
};
