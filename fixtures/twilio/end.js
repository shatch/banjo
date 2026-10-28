// Where every fixture's <Record> goes when it finishes: hangs up. Without an
// action, Twilio requests the same function again, so the first live IVR run
// (2026-10-27) went back to the menu after each recording, and Banjo heard a
// loop no real line would play.
exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  twiml.hangup();
  callback(null, twiml);
};
