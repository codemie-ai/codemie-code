/**
 * Easter egg messages for session lifecycle
 * Randomly selected to add personality to the CLI
 */

/**
 * Welcome messages shown at session start
 */
const WELCOME_MESSAGES = [
  // Motivational
  '🚀 Ready to build something amazing.',
  '✨ Let\'s create something extraordinary.',
  '🪄 Time to make magic happen.',
  '💡 Your next breakthrough starts now.',
  '🎯 Let\'s turn ideas into reality.',
  '⚡ Innovation mode: activated.',
  '🌍 Ready to change the world?',
  '🔮 Let\'s build the future.',
  '🎨 Your creativity, my assistance.',
  '💫 Dream it. Code it. Ship it.',

  // Energetic
  '🔥 Let\'s go!',
  '⚡ Fire up those neurons.',
  '🚢 Time to ship some code.',
  '💪 Let\'s make this happen.',
  '👍 Ready when you are.',
  '🚀 Engines engaged.',
  '✅ All systems go.',
  '⚡ Let\'s do this thing.',
  '🏎️ Buckle up, here we go.',
  '🚀 Full speed ahead.',

  // Friendly
  '👋 Hello, builder.',
  '🎉 Welcome back, creator.',
  '😊 Good to see you again.',
  '🤝 Let\'s build together.',
  '🤖 Your AI pair programmer is ready.',
  '🙌 At your service.',
  '💪 Ready to help you succeed.',
  '👥 Let\'s collaborate.',
  '🧠 Two minds are better than one.',
  '🤖 Your coding companion is here.',

  // Professional
  '⚙️ Session initialized.',
  '🎯 Standing by for instructions.',
  '📋 Ready for your next command.',
  '✅ System ready.',
  '🤖 Agent online.',
  '💭 Awaiting your brilliant ideas.',
  '✅ Configuration loaded successfully.',
  '▶️ Ready to execute.',
  '🔧 All tools loaded and ready.',
  '⚡ Primed for productivity.',

  // Playful
  '📝 Let\'s write some poetry... in code.',
  '🐛 Time to wrangle some bugs.',
  '📞 The code is calling.',
  '🗺️ Adventure awaits in your terminal.',
  '☕ Let\'s turn coffee into code.',
  '🐛 Debugging mode: optional.',
  '⭐ May the code be with you.',
  '🧠 Ready to compile some genius.',
  '🤖 Let\'s make the machines do our bidding.',
  '🧙 Code wizard mode: activated.',

  // Confident
  '💪 You\'ve got this.',
  '🔥 Let\'s crush it.',
  '🌟 Today\'s the day.',
  '🎯 Show them what you\'re made of.',
  '📈 Time to level up.',
  '🏆 Let\'s make it legendary.',
  '👑 Ready to dominate.',
  '🅰️ Bring your A-game.',
  '📊 Let\'s set the bar higher.',
  '🚀 Time to exceed expectations.',

  // Inspiring
  '✍️ Every line of code matters.',
  '👣 Small steps, big impact.',
  '📈 Progress over perfection.',
  '🔮 You\'re building tomorrow, today.',
  '🌟 The best code is yet to come.',
  '🎯 Your vision deserves great execution.',
  '⭐ Excellence is a habit.',
  '🔍 Details make the difference.',
  '🥇 Quality first, always.',
  '🎨 Let\'s craft something beautiful.'
];

/**
 * Goodbye messages shown at session exit
 */
const GOODBYE_MESSAGES = [
  // Motivational
  '🚀 Build something amazing.',
  '💭 Dream big, code bigger.',
  '🌍 The world needs your code.',
  '💪 Make it happen.',
  '📜 Now go make history.',
  '🎯 You got this!',
  '🎨 Your code is poetry.',
  '⏰ The future is now.',
  '🌍 Change the world, one commit at a time.',
  '💡 Innovation starts here.',

  // Developer Culture
  '🚢 Ship it!',
  '📦 Keep shipping.',
  '😊 Happy coding!',
  '💻 Code on!',
  '🚀 Time to deploy.',
  '💰 Commit, push, profit.',
  '🔀 Merge with confidence.',
  '✅ Tests passed? Ship it!',
  '💚 May your builds be green.',
  '📅 Another day, another deploy.',

  // Humor
  '🐛 Bugs? What bugs?',
  '💥 Go break things (in staging).',
  '☕ Coffee break?',
  '🖥️ It works on my machine!',
  '💾 Did you commit your changes?',
  '📤 Remember to git push.',
  '📚 Stack Overflow is your friend.',
  '🎉 No semicolons were harmed.',
  '⚔️ Tabs > Spaces. Fight me.',
  '🎵 99 bugs in the code... 99 bugs...',

  // Productivity
  '🔧 Time to ship some features.',
  '🔮 Let\'s build the future.',
  '🧠 Code smarter, not harder.',
  '⚡ Efficiency is your superpower.',
  '📈 One step closer to production.',
  '📊 Progress over perfection.',
  '💾 Small commits, big impact.',
  '🚀 Refactor later, ship now.',
  '✅ Done is better than perfect.',
  '🔥 Keep the momentum going.',

  // Wisdom
  '🐛 Every bug is a learning opportunity.',
  '📖 Documentation is love.',
  '📝 Write code humans can read.',
  '😊 Clean code is happy code.',
  '🧪 Test early, test often.',
  '⚠️ Premature optimization is evil.',
  '💋 KISS: Keep It Simple, Stupid.',
  '🔄 DRY: Don\'t Repeat Yourself.',
  '👥 Code reviews make you better.',
  '🏷️ Naming things is hard. You nailed it.',

  // Achievement
  '🏆 Another victory!',
  '✅ Mission accomplished.',
  '💪 You crushed it!',
  '📈 Level up!',
  '🎮 Achievement unlocked.',
  '✨ That was smooth.',
  '👑 Like a pro.',
  '🎯 Nailed it!',
  '💯 Flawless execution.',
  '🔥 You\'re on fire!',

  // Fun
  '⭐ May the code be with you.',
  '🙏 In code we trust.',
  '☕ Powered by coffee and determination.',
  '🌊 The code must flow.',
  '🖖 Code long and prosper.',
  '🚀 To infinity and beyond!',
  '🕷️ With great code comes great responsibility.',
  '🌳 I am Groot. (Translation: Good job!)',
  '❄️ Winter is coming... better deploy now.',
  '🥄 There is no spoon. Only code.'
];

/**
 * Get a random welcome message for session start
 */
export function getRandomWelcomeMessage(): string {
  return WELCOME_MESSAGES[Math.floor(Math.random() * WELCOME_MESSAGES.length)];
}

/**
 * Get a random goodbye message for session exit
 */
export function getRandomGoodbyeMessage(): string {
  return GOODBYE_MESSAGES[Math.floor(Math.random() * GOODBYE_MESSAGES.length)];
}

/**
 * Get total count of welcome messages
 */
export function getWelcomeMessageCount(): number {
  return WELCOME_MESSAGES.length;
}

/**
 * Get total count of goodbye messages
 */
export function getGoodbyeMessageCount(): number {
  return GOODBYE_MESSAGES.length;
}
