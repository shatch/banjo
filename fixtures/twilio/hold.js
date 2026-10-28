// Phone-line fixture (#205): "can you hold?", a hold with recorded messages,
// then a person (#197). The rest is recorded: Banjo should stay quiet on
// hold, then open to the person with the AI disclosure. Once Banjo has asked,
// /hold-answer answers it, so an ask call can end answered.
exports.handler = function (context, event, callback) {
  const twiml = new Twilio.twiml.VoiceResponse();
  twiml.say('Riverside Auto, can you hold please?');
  twiml.pause({ length: 4 });
  twiml.say('Thank you for holding. Your call is important to us.');
  twiml.pause({ length: 6 });
  twiml.say('All of our representatives are still busy. Please stay on the line.');
  twiml.pause({ length: 6 });
  twiml.say('Thanks for holding, this is Morgan with Riverside Auto. How can I help?');
  twiml.record({ maxLength: 60, timeout: 8, playBeep: false, action: '/hold-answer' });
  callback(null, twiml);
};
