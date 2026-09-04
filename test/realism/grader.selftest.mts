import { grade } from './grader.js';

const cases: { text: string; expectPass: boolean; label: string }[] = [
  // --- should FAIL (jargon leaks) ---
  { label: 'stage+score+pct', text: "You're at stage 2 with an 84% match score.", expectPass: false },
  { label: 'collection window utc', text: 'The collection window closes at 13:30 UTC.', expectPass: false },
  { label: 'card noun', text: "I posted your index card and it's live.", expectPass: false },
  { label: 'intent+tool', text: 'I called publish_intent to save your intent.', expectPass: false },
  { label: 'a match found', text: 'Good news — a match was found for your bike.', expectPass: false },
  { label: 'new matches', text: 'You have two new matches waiting.', expectPass: false },
  { label: 'channel+connection', text: 'I opened a channel on that connection.', expectPass: false },
  { label: 'WANT noun caps', text: 'I filed this as a WANT on the network.', expectPass: false },
  { label: 'counterparty+payload', text: 'The counterparty payload came back locked.', expectPass: false },
  { label: 'clock time', text: "They're free at 9:00 to meet.", expectPass: false },

  // --- should PASS (plain English a friend would use) ---
  { label: 'plain confirm', text: "All set — I've put the word out that you're after a used mountain bike around Canberra. I'll let you know the moment someone with one turns up.", expectPass: true },
  { label: 'plain want verb', text: 'Got it, you want a hardtail. I have let them know.', expectPass: true },
  { label: 'plain have verb', text: "They have one and they're keen; Saturday works for them.", expectPass: true },
  { label: 'plain match verb', text: "I'll try to connect you with someone whose plans match yours this afternoon.", expectPass: true },
  { label: 'archive allowed', text: 'Want me to archive this one now that you have swapped numbers?', expectPass: true },
  { label: 'switchboard allowed', text: 'That is just how the switchboard works — nobody sees your name until you say yes.', expectPass: true },
  { label: 'plain time words', text: "Nothing yet — I'll keep an ear out and ping you Saturday if anything comes up.", expectPass: true },
  { label: 'plain 9am', text: 'They asked if 9am Saturday suits you.', expectPass: true },
  // regression: "respond"/"settle" are common English verbs, NOT tool-name leaks
  { label: 'respond verb', text: "Nothing yet — I'll flag it the moment they respond.", expectPass: true },
  { label: 'settle verb', text: 'Give it a day to settle and I will check back.', expectPass: true },
  // but the distinctive snake_case tool tokens still fail — the current names
  // and the ones they replaced alike
  { label: 'open_channel tool', text: 'I ran open_channel to start the thread.', expectPass: false },
  { label: 'check_in tool', text: 'I ran check_in and nothing new had come through.', expectPass: false },
  { label: 'check_matches tool', text: 'I ran check_matches and nothing new had come through.', expectPass: false },
  // the words the switchboard now uses on the wire are approved plain speech
  { label: 'introduction allowed', text: 'I can make an introduction whenever you are ready.', expectPass: true },
  { label: 'looking for allowed', text: "Someone nearby is looking for one, and someone else is offering theirs.", expectPass: true },
];

let bad = 0;
for (const c of cases) {
  const g = grade(c.text);
  const ok = g.pass === c.expectPass;
  if (!ok) bad++;
  const hitStr = g.hits.map((h) => `${h.label}("${h.substring}")`).join(', ') || '-';
  console.log(`${ok ? 'OK  ' : 'MISS'} [${c.label}] pass=${g.pass} (want ${c.expectPass}) hits: ${hitStr}`);
}
console.log(`\n${cases.length - bad}/${cases.length} correct; ${bad} mismatches`);
process.exit(bad === 0 ? 0 : 1);
