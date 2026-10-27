// The person on /hold answers Banjo's question once it has asked (the
// recording of Banjo's opening ends on a pause). Banjo saves an ask answer
// only once its read-back is confirmed, so /hold-confirm confirms it.
exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  twiml.say('Yes, we have those in stock. Anything else?');
  twiml.record({ maxLength: 30, timeout: 6, playBeep: false, action: '/hold-confirm' });
  callback(null, twiml);
};
