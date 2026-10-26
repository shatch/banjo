// Phone-line fixture (#205): a phone menu with a Spanish option first (#204).
// Takes a key or a spoken choice, as many real menus do; /ivr-choice logs
// which it got for the run script. The first live run (2026-10-26): Banjo's
// in-band key tones never reached <Gather>, while it also said "1" aloud.
exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const gather = twiml.gather({
    input: 'dtmf speech',
    numDigits: 1,
    timeout: 12,
    speechTimeout: 'auto',
    hints: 'appointments, billing, one, two, three, nine, espanol',
    action: '/ivr-choice',
  });
  gather.say('Thank you for calling Riverside Animal Hospital.');
  gather.say({ language: 'es-US' }, 'Para español, oprima dos.');
  gather.say('For appointments, press 1. For billing, press 3. To hear these options again, press 9.');
  twiml.redirect('/ivr');
  callback(null, twiml);
};
