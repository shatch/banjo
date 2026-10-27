// Confirms Banjo's read-back of the /hold-answer answer, then the call is
// recorded until Banjo says goodbye and hangs up.
exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  twiml.say("Yes, that's right.");
  twiml.record({ maxLength: 30, timeout: 6, playBeep: false, action: '/end' });
  callback(null, twiml);
};
