// Phone-line fixture (#225): the /ivr menu, but taking keys only, as many
// real menus do. Saying the option does nothing here, and neither do key
// tones sent as audio: Twilio's <Gather> takes only a real key press. A
// caller that doesn't press one hears the menu again.
exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  const gather = twiml.gather({ input: 'dtmf', numDigits: 1, timeout: 6, action: '/ivr-choice' });
  gather.say('Thank you for calling Riverside Animal Hospital.');
  gather.say({ language: 'es-US' }, 'Para español, oprima dos.');
  gather.say('For appointments, press 1. For billing, press 3. To hear these options again, press 9.');
  twiml.redirect('/ivr-keys');
  callback(null, twiml);
};
