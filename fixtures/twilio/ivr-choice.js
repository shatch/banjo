// The choice made on the /ivr menu, logged as "ivr pressed <digit> by
// <dtmf|speech>" for the run script, then a person answers and the rest of
// the call is recorded.
const SPOKEN = [
  [/\b(appointments?|one|1)\b/i, '1'],
  [/\b(espa[nñ]ol|spanish|dos|two|2)\b/i, '2'],
  [/\b(billing|three|3)\b/i, '3'],
  [/\b(again|nine|9)\b/i, '9'],
];

exports.handler = function (context, event, callback) {
  const spoken = event.SpeechResult ? SPOKEN.find(([re]) => re.test(event.SpeechResult)) : undefined;
  const digit = event.Digits || (spoken && spoken[1]) || '?';
  console.log(`ivr pressed ${digit} by ${event.Digits ? 'dtmf' : 'speech'}`);
  const twiml = new Twilio.twiml.VoiceResponse();
  if (digit === '9' || digit === '?') {
    twiml.redirect('/ivr');
    return callback(null, twiml);
  }
  twiml.say('Riverside Animal Hospital, this is Dana. How can I help you?');
  twiml.record({ maxLength: 60, timeout: 8, playBeep: false });
  callback(null, twiml);
};
