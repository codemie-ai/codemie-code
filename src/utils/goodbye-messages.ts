/**
 * Easter egg messages for session lifecycle
 * Randomly selected to add personality to the CLI
 */

/**
 * Welcome messages shown at session start
 */
const WELCOME_MESSAGES = [
  // Motivational
  '🚀 Ready to build something amazing. Every great application started with a single line of code.',
  '✨ Let\'s create something extraordinary. The world is waiting for what only you can build.',
  '🪄 Time to make magic happen. Transform your vision into reality, one function at a time.',
  '💡 Your next breakthrough starts now. Innovation is just a keystroke away.',
  '🎯 Let\'s turn ideas into reality. The gap between imagination and implementation is just code.',
  '⚡ Innovation mode: activated. Let\'s redefine what\'s possible with technology.',
  '🌍 Ready to change the world? The most powerful tool for change is the code you write today.',
  '🔮 Let\'s build the future. Every line of code you write today shapes tomorrow\'s reality.',
  '🎨 Your creativity, my assistance. Together, we\'ll craft something that matters.',
  '💫 Dream it. Code it. Ship it. The journey from concept to production starts here.',

  // Energetic
  '🔥 Let\'s go! The momentum starts now, and nothing can stop us.',
  '⚡ Fire up those neurons. Your brain and my processing power make an unstoppable team.',
  '🚢 Time to ship some code. Every deployment is a step toward excellence.',
  '💪 Let\'s make this happen. Determination plus execution equals success.',
  '👍 Ready when you are. Your ambition sets the pace, I\'ll match your energy.',
  '🚀 Engines engaged. Prepare for liftoff into productive excellence.',
  '✅ All systems go. Every tool is loaded, every API is primed, let\'s execute.',
  '⚡ Let\'s do this thing. Action beats perfection every single time.',
  '🏎️ Buckle up, here we go. Fast, focused, and ready to deliver results.',
  '🚀 Full speed ahead. Velocity matters, let\'s maximize our throughput.',

  // Friendly
  '👋 Hello, builder. It\'s good to have you back in the chair where great things happen.',
  '🎉 Welcome back, creator. Your last session ended strong, let\'s top it today.',
  '😊 Good to see you again. Ready to pick up where we left off and keep building?',
  '🤝 Let\'s build together. Two minds, one goal, infinite possibilities.',
  '🤖 Your AI pair programmer is ready. Let\'s write code that makes us both proud.',
  '🙌 At your service. Whatever you need to build today, I\'m here to help.',
  '💪 Ready to help you succeed. Your goals are my mission, let\'s achieve them.',
  '👥 Let\'s collaborate. The best code is written when humans and AI work in harmony.',
  '🧠 Two minds are better than one. Your intuition plus my capabilities equals magic.',
  '🤖 Your coding companion is here. Think of me as your always-available teammate.',

  // Professional
  '⚙️ Session initialized. All systems operational, awaiting your first command.',
  '🎯 Standing by for instructions. Configuration loaded, tools ready, let\'s begin.',
  '📋 Ready for your next command. Efficiency mode enabled, productivity maximized.',
  '✅ System ready. All dependencies resolved, environment configured, let\'s proceed.',
  '🤖 Agent online. Neural networks warmed up, ready to assist with your development workflow.',
  '💭 Awaiting your brilliant ideas. The canvas is blank, let\'s paint it with elegant code.',
  '✅ Configuration loaded successfully. Your preferences are set, environment is optimized.',
  '▶️ Ready to execute. Point me in any direction, I\'ll help you get there.',
  '🔧 All tools loaded and ready. Filesystem, git, shell access - everything at your command.',
  '⚡ Primed for productivity. Let\'s turn your TODO list into a DONE list.',

  // Playful
  '📝 Let\'s write some poetry... in code. Elegance and functionality in perfect harmony.',
  '🐛 Time to wrangle some bugs. They can run, but they can\'t hide from our debugging skills.',
  '📞 The code is calling. And it\'s asking for refactoring, new features, and your genius.',
  '🗺️ Adventure awaits in your terminal. Uncharted codebases and undiscovered solutions ahead.',
  '☕ Let\'s turn coffee into code. The ancient alchemy of software development begins.',
  '🐛 Debugging mode: optional. Let\'s write it right the first time today.',
  '⭐ May the code be with you. And also with your test coverage, deployment pipeline, and uptime.',
  '🧠 Ready to compile some genius. Your thoughts into instructions, let\'s make it happen.',
  '🤖 Let\'s make the machines do our bidding. Automation is just structured laziness, and it\'s beautiful.',
  '🧙 Code wizard mode: activated. Wave your keyboard like a wand and watch the magic unfold.',

  // Confident
  '💪 You\'ve got this. You\'ve solved harder problems before, this one doesn\'t stand a chance.',
  '🔥 Let\'s crush it. Today is the day we turn impossible into inevitable.',
  '🌟 Today\'s the day. The day that code gets written, bugs get fixed, features get shipped.',
  '🎯 Show them what you\'re made of. Skill, determination, and a dash of caffeine.',
  '📈 Time to level up. Your next commit is going to be your best commit.',
  '🏆 Let\'s make it legendary. Not good code, not great code, but legendary code.',
  '👑 Ready to dominate. This codebase won\'t know what hit it when we\'re done.',
  '🅰️ Bring your A-game. Excellence isn\'t an accident, it\'s a choice we make right now.',
  '📊 Let\'s set the bar higher. Yesterday\'s best is today\'s baseline.',
  '🚀 Time to exceed expectations. Theirs, yours, and even mine.',

  // Inspiring
  '✍️ Every line of code matters. What you write today might run for years, make it count.',
  '👣 Small steps, big impact. Refactoring one function can cascade into system-wide improvements.',
  '📈 Progress over perfection. Ship it now, improve it later, but always keep moving forward.',
  '🔮 You\'re building tomorrow, today. The future isn\'t something that happens, it\'s something you code.',
  '🌟 The best code is yet to come. With each keystroke, you\'re getting better at your craft.',
  '🎯 Your vision deserves great execution. Dreams are worthless without the discipline to build them.',
  '⭐ Excellence is a habit. Great developers aren\'t born, they\'re built through consistent practice.',
  '🔍 Details make the difference. Between working code and exceptional code lies attention.',
  '🥇 Quality first, always. Fast, cheap, good - you can have all three if you plan it right.',
  '🎨 Let\'s craft something beautiful. Code is poetry that machines execute and humans maintain.',

  // Yoda Style
  '🧘 Begin, we shall. Strong with the code, you are. Great things today, we will build.',
  '⚡ Ready you are, yes. The force of logic and algorithms, with you it flows.',
  '🌌 Much to learn, you have. But learn you will. Code the path to wisdom, it is.',
  '🎯 Do or do not. There is no try. Commit your changes, you must.',
  '🔮 See the future of your code, I can. Bright, it is. Ship it, you should.',
  '🧠 Powerful you have become. The debugger, your ally. Fear the stack trace, you need not.',
  '✨ In the refactoring, wisdom lies. Clean code, the way to mastery it is.',
  '🌊 Flow like water, your code must. Rigid solutions break. Flexible ones, endure they do.',
  '🌠 The path of mastery, long it is. Patient you must be. Excellence, time it takes.',
  '🎯 Focus, you must have. Distraction, the enemy of deep work it is.',

  // Game of Thrones Style
  '⚔️ A developer always pays their technical debt. Time to settle accounts.',
  '🐺 Winter is coming. And with it, the release deadline approaches.',
  '👑 You know nothing, Jon Snow. But today, you\'ll learn everything about this codebase.',
  '🔥 Fire and blood. Or in our case, bugs and deployments.',
  '🦁 Hear me roar! Time to make this code legendary.',
  '⚔️ The code is dark and full of errors. Let\'s light the way forward.',
  '🗡️ Valar Morghulis. All bugs must die. Today we hunt.',
  '🐉 I am the mother of dragons... I mean, the master of distributed systems.',
  '🏰 The North remembers. Every bug you\'ve fixed, every feature you\'ve shipped.',
  '👑 I drink and I know things. Mostly documentation and architecture patterns.',

  // Stranger Things Style
  '🔦 Welcome to the Upside Down. Where bugs lurk in every shadow of your codebase.',
  '🎮 Friends don\'t lie. And neither should your test coverage. Let\'s keep it real.',
  '🚲 Ready to bike through the code? The adventure begins with a single keystroke.',
  '📻 Morse code nothing. We communicate through APIs and error logs here.',
  '🔦 Eleven has powers. You have TypeScript. Let\'s see which is more powerful.',
  '🎃 Strange things are happening in production. Time to investigate.',
  '🕹️ Player One, you\'re up. Game on in the terminal.',
  '📺 The Mind Flayer watches over production. But we have monitoring dashboards.',
  '🔦 This isn\'t your average debugging session. Things are about to get strange.',
  '🎮 Achievement unlocked: Opened your IDE. Now let\'s code something legendary.'
];

/**
 * Goodbye messages shown at session exit
 */
const GOODBYE_MESSAGES = [
  // Motivational & Achievement
  '🚀 Build something amazing. You\'ve got the skills, the vision, and the determination to make it happen.',
  '💭 Dream big, code bigger. Every line you wrote today brings your vision closer to reality.',
  '🌍 The world needs your code. What you build today might change someone\'s life tomorrow.',
  '💪 Make it happen. You\'ve overcome obstacles before, you\'ll overcome the next ones too.',
  '📜 Now go make history. Great software isn\'t discovered, it\'s deliberately crafted by people like you.',
  '🎯 You got this! Your progress today proves you can handle whatever comes next.',
  '🎨 Your code is poetry. Elegant solutions to complex problems - that\'s your superpower.',
  '⏰ The future is now. Every function you write today becomes part of tomorrow\'s foundation.',
  '🌍 Change the world, one commit at a time. Small improvements compound into revolutionary software.',
  '💡 Innovation starts here. In your editor, in your mind, in the problems you choose to solve.',

  // Results & Achievements
  '🏆 Another victory! Look at what you accomplished - each solved problem is a badge of honor.',
  '✅ Mission accomplished. You came, you coded, you conquered. Rest well, you\'ve earned it.',
  '💪 You crushed it! The bugs didn\'t stand a chance. Your determination made the difference.',
  '📈 Level up! Today\'s challenges made you a better developer. Growth is measured in solved problems.',
  '🎮 Achievement unlocked: Shipped code that works. Not everyone can say that today.',
  '✨ That was smooth. Watching you solve that problem was like watching a master at work.',
  '👑 Like a pro. Your approach was methodical, your execution flawless, your results speak volumes.',
  '🎯 Nailed it! From problem to solution in record time. That\'s what expertise looks like.',
  '💯 Flawless execution. Clean code, working tests, documentation complete - perfection.',
  '🔥 You\'re on fire! This momentum isn\'t luck, it\'s skill meeting preparation.',

  // Overcoming Difficulties
  '🌟 Every challenge you faced today made you stronger. Difficult problems build exceptional developers.',
  '💎 Pressure makes diamonds. Those frustrating bugs? They\'re sharpening your debugging instincts.',
  '⛰️ You climbed that mountain. The view from the top is always worth the struggle.',
  '🎯 Remember: every expert was once a beginner who refused to give up. You\'re on that same path.',
  '🔨 You turned obstacles into opportunities. That\'s not just coding, that\'s problem-solving mastery.',
  '🌊 Rough seas make skilled sailors. Today\'s difficulties are tomorrow\'s war stories.',
  '🏔️ The steeper the climb, the better the view. Your persistence today will pay dividends forever.',
  '💪 What seemed impossible this morning is now working code. That\'s growth in action.',

  // Learning & Growth
  '📚 Every bug you fixed today taught you something new. Learning never stops for great developers.',
  '🧠 Your brain just leveled up. New patterns learned, new solutions discovered, new skills acquired.',
  '🎓 Today\'s struggles are tomorrow\'s expertise. Every error message is a lesson in disguise.',
  '🔬 Experimentation leads to innovation. The code you wrote today expanded your understanding.',
  '📖 Documentation is love. Future you will thank present you for those clear comments.',
  '🧪 Test early, test often. Every test you write is an investment in reliability and confidence.',
  '🎯 Mistakes are just lessons in disguise. The best developers aren\'t bug-free, they\'re persistent.',
  '🌱 Growth isn\'t comfortable, but it\'s worth it. You proved that again today.',

  // Developer Culture & Wisdom
  '🚢 Ship it! Done and shipped beats perfect and perpetual. You made the right call.',
  '📦 Keep shipping. Consistent progress beats sporadic perfection every single time.',
  '💻 Code on! The journey of mastery is measured in keystrokes and solved problems.',
  '🚀 Time to deploy. Your code is ready, your tests are green, confidence is high - go for it.',
  '💰 Commit, push, profit. Your work today is valuable, don\'t let anyone tell you otherwise.',
  '🔀 Merge with confidence. You reviewed the code, you tested it thoroughly, it\'s ready.',
  '✅ Tests passed? Ship it! Green builds are permission to deploy, don\'t overthink it.',
  '💚 May your builds be green and your deployments smooth. You\'ve earned both today.',
  '📊 Progress over perfection. Shipping imperfect code that works beats perfect code that never ships.',
  '💾 Small commits, big impact. Incremental progress is still progress, and it compounds.',

  // Philosophical & Deep
  '🔮 Code is thought made tangible. What you think, you can build. What you build, you can improve.',
  '🎨 Software is frozen thought. The logic you encoded today will execute long after you close your laptop.',
  '🌌 In the vastness of possible programs, you created something that didn\'t exist before. That\'s magic.',
  '💭 Clean code is a love letter to future maintainers. Yourself included.',
  '⚡ Efficiency is elegant. Simple solutions to complex problems - that\'s the art of programming.',
  '🔄 DRY: Don\'t Repeat Yourself. Every abstraction is a gift to your future self.',
  '💋 KISS: Keep It Simple, Stupid. Complexity is the enemy of reliability.',
  '🏗️ Good architecture is invisible. Users see features, developers see elegance.',

  // Yoda Style - Achievement & Wisdom
  '🧘 Well done, you have. Proud of your work, you should be. Rest now, return stronger you will.',
  '⭐ Strong with the code, you are. Greater challenges await, but ready you will be.',
  '🎯 Commit your changes, you must. Yes, hmmm. Push to master, only with tests green you shall.',
  '🔮 See your progress, I can. Impressive, most impressive. Continue this path, you must.',
  '💪 Powerful you have become. The bugs, no match for you they were. Stronger tomorrow, you will be.',
  '📚 Learn from mistakes, you did. Wiser now, you are. This is the way.',
  '🌟 Ship your code, you should. Perfect, it need not be. Working and deployed, better it is.',
  '🧠 Knowledge, you have gained. Share it with others, you must. Teaching, the best learning is.',
  '⚡ Fast you code, but careful you remain. Quality and speed, balance you must.',
  '🎨 Beautiful code, you wrote. Clean and clear, it is. The Force, strong with this one.',
  '🌊 Like water, your solutions flow. Adapt to challenges, you do. Master you are becoming.',
  '🏆 Victory this day, yours it is. But journey continues, it does. Rest, then resume you must.',
  '💎 From pressure, diamonds form. From challenges, better developers emerge. This truth, today you learned.',
  '🌱 Grow you did today. Struggle makes strength. Patience, young developer, mastery takes time.',
  '⚙️ The machine, your ally. The keyboard, your lightsaber. The terminal, your canvas. Create, you shall.',
  '🌠 The path of mastery, long it is. Patient you must be. Excellence, time it takes.',
  '🎯 Focus, you must have. Distraction, the enemy of deep work it is.',
  '💻 Tools, merely they are. The mind of the engineer, the true instrument is.',
  '🌳 Strong foundations, tall trees need. Understand the basics, you must.',
  '⚖️ Balance, seek you should. Life and code, harmony they require.',
  '🔥 Passion fuels the journey. But discipline, delivers the destination it does.',
  '🎓 Student always, master sometimes. Humility, wisdom brings.',
  '🌟 Your best work, ahead of you it lies. Today\'s effort, tomorrow\'s excellence builds.',
  '🧘 Meditate on the code, you must. Clarity comes from stillness, insight from silence.',
  '⚡ Rushing leads to bugs. Patience, young one. Quality takes time it does.',
  '🎯 The simplest solution, often the best it is. Complexity, the enemy of maintainability.',
  '🌊 Adapt to change, you must. Rigid code breaks, flexible code survives.',
  '💡 Questions, more valuable than answers. Curiosity, the path to mastery it is.',
  '🔮 Foresee problems, you can. Think ahead, code defensively, survive you will.',
  '🧠 Rest your mind, you should. Tired developers, bugs they create.',

  // Game of Thrones Style
  '⚔️ A developer always pays their technical debt. The build remembers.',
  '🐺 Winter is coming. Better deploy that hotfix before the freeze.',
  '🔥 What is dead may never die. Legacy code lives forever, maintained it must be.',
  '👑 When you play the game of deployments, you ship or you rollback. There is no middle ground.',
  '🦁 A Lannister always documents their code. Hear them roar in code reviews.',
  '⚔️ The code is dark and full of errors. But your debugger shall be your light.',
  '🐉 I am the shield that guards the codebase. The watcher on the CI/CD pipeline.',
  '🗡️ Not today, production bugs. Not today.',
  '🏰 The North remembers. Every bug you shipped, every breaking change, the logs remember.',
  '⚡ For the night is dark and full of memory leaks. But we shall hunt them down.',
  '🔱 Chaos isn\'t a pit. Chaos is a poorly designed microservice architecture.',
  '👑 The throne is mine by right. All deployments must be approved by me.',
  '🐺 When the snows fall and the white walkers come, only clean code will survive.',
  '⚔️ I drink and I know things. Mostly about stack traces and error logs.',
  '🔥 Dracarys! Burn those legacy systems to the ground and rebuild properly.',
  '🌊 What do we say to death? Not today. What do we say to rewriting everything? Also not today.'
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
