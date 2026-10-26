// Phone-line fixture (#205): a voicemail. A greeting, then <Record>, which
// plays its own beep. The run script checks the recording: the AI
// disclosure first, the message once, and nothing before the beep lost.
exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  twiml.say("Hi, you've reached Claudia's Dog Grooming. We can't come to the phone right now.");
  twiml.say('Please leave your name, number and a short message after the tone.');
  twiml.record({ maxLength: 90, timeout: 6, playBeep: true, trim: 'do-not-trim' });
  callback(null, twiml);
};
