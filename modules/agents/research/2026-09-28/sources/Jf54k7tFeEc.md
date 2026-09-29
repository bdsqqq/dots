# Turn off Claude Code's Memory

source: https://www.youtube.com/watch?v=Jf54k7tFeEc
youtube upload_date (UTC): 20260825
duration: 00:39:28
captions: youtube automatic, en-orig; not human-verified.
speaker changes, proper names, and punctuation may be wrong.
timestamps are caption start times; no editorial summarization.

[00:00:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=0s) For AI to work effectively in a
[00:00:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1s) codebase, it needs to know what the
[00:00:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=3s) codebase is, where things are, and how
[00:00:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=5s) to get stuff done. I have found that a
[00:00:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=7s) lot of people want to store this
[00:00:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=8s) information in some special way that AI
[00:00:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=11s) agents will operate with. Well, I've
[00:00:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=13s) seen so many different systems and
[00:00:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=14s) libraries and plugins and features and
[00:00:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=16s) stuff that people have built over the
[00:00:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=18s) last few years to try and automatically
[00:00:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=20s) encode what they're doing in the
[00:00:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=22s) codebase in some special way that'll
[00:00:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=24s) make the agent always do what they want.
[00:00:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=26s) I've even noticed that in claude code
[00:00:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=28s) recently, it seems to use its memory a
[00:00:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=30s) whole bunch where it will save things in
[00:00:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=32s) some magic hidden file somewhere on the
[00:00:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=34s) computer after you ask it to do
[00:00:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=36s) something. And now it will keep randomly
[00:00:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=38s) doing that forever. If you can't tell
[00:00:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=40s) from how I've been spinning this so far,
[00:00:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=42s) I'm not a fan of these memory systems. I
[00:00:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=45s) don't think memory is the right place to
[00:00:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=46s) keep track of how things should be done
[00:00:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=48s) in your codebase. That worked okay with
[00:00:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=50s) humans because previously before AI was
[00:00:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=52s) writing all our code, the knowledge was
[00:00:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=54s) always in the people's brains. They
[00:00:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=55s) would try to put it other places like
[00:00:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=57s) documentation and whatnot, but in the
[00:00:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=59s) end, what we knew is what mattered. Now
[00:01:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=61s) we're working with agents that forget
[00:01:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=62s) everything when a new thread spins up.
[00:01:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=64s) And our desperate attempts to have them
[00:01:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=66s) automatically save things to be in the
[00:01:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=68s) next run is just not great. It's not
[00:01:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=70s) great at all. And I'm far from the only
[00:01:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=72s) person who feels this way. This clip
[00:01:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=75s) comes from a conversation that Mario,
[00:01:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=77s) the creator of Pi, had with Armen, the
[00:01:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=80s) creator of Flask. They now work together
[00:01:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=82s) building a bunch of cool AI tooling
[00:01:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=84s) stuff. And obviously, Pi is a super
[00:01:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=86s) cool, powerful, useful piece of the new
[00:01:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=89s) agentic engineering world. I love both
[00:01:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=91s) of these guys. I especially love Mario.
[00:01:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=93s) He's been awesome to chat with, and his
[00:01:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=94s) understanding these things is great. And
[00:01:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=96s) I have a feeling he's going to have some
[00:01:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=98s) real fun spicy takes as we dive in. So,
[00:01:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=101s) if you're trying to figure out how to
[00:01:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=102s) make agents behave properly in your
[00:01:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=104s) codebase or you just want to understand
[00:01:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=106s) this stuff well enough to have better
[00:01:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=107s) conversations with your co-workers and
[00:01:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=109s) keep them from destroying your agentic
[00:01:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=111s) systems with all these terrible memory
[00:01:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=113s) things, I think you'll get a lot out of
[00:01:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=114s) this video. But one other thing you
[00:01:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=116s) should be able to get a lot out of is
[00:01:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=117s) today's sponsor. Do you know what
[00:01:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=118s) OpenAI, Anthropic, Cursor, and Thinking
[00:02:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=120s) Machines all have in common? Because
[00:02:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=122s) it's not just that they're trying to
[00:02:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=123s) make models, it's that they all use
[00:02:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=125s) today's sponsor, Work OS. You might be
[00:02:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=127s) confused why so many big companies are
[00:02:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=129s) choosing to use a product like work OS
[00:02:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=130s) instead of rolling their own O,
[00:02:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=132s) especially nowadays where agents can
[00:02:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=133s) just do it for you, right? Well, kind
[00:02:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=136s) of. They can go set up a sign-in page.
[00:02:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=138s) They might even be able to start doing
[00:02:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=139s) the Google Oath flows that you want. But
[00:02:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=141s) as soon as you want real enterprise
[00:02:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=143s) ready O so that businesses can sign into
[00:02:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=145s) your applications, you're kind of
[00:02:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=147s) screwed. That's where Work OS comes in
[00:02:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=149s) with their admin portal, making it
[00:02:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=151s) trivial for you to onboard real
[00:02:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=152s) businesses onto your services. You send
[00:02:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=155s) the company a link, they sign up with
[00:02:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=156s) whatever identity provider they prefer,
[00:02:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=158s) and now they're good to go in your app.
[00:02:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=160s) So, Work Quest is Enterprise covered.
[00:02:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=161s) Obviously, they also have traditional
[00:02:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=163s) consumers covered with OKIT and all of
[00:02:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=165s) the stuff that they need to do
[00:02:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=166s) traditional OOTH and sign in with Google
[00:02:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=168s) and whatever else. But there's a third
[00:02:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=169s) type of user that they have covered,
[00:02:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=171s) too. Agents. Turns out agents will need
[00:02:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=173s) a way to sign into your stuff, too. And
[00:02:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=175s) that's why work OS created OMD alongside
[00:02:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=177s) a bunch of other important companies
[00:02:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=179s) like Cloudflare, Firecrawl, Resend,
[00:03:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=180s) Monday, Kernel, and so many other
[00:03:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=182s) awesome businesses. As agents do more
[00:03:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=184s) and more on our behalf, they need a way
[00:03:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=186s) to sign up for us. And that's what OMD
[00:03:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=188s) is here to introduce. So if you want to
[00:03:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=190s) make your app usable by consumers,
[00:03:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=192s) enterprise, and agents, get started
[00:03:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=193s) today at swordv.link/workos.
[00:03:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=196s) When I heard his first two sentences, I
[00:03:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=197s) realized this was good enough to be a
[00:03:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=198s) video, which is why it's a video now. So
[00:03:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=200s) let's watch the whole thing together.
[00:03:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=202s) Yeah, but coming back to memory systems,
[00:03:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=203s) uh, so for coding, I don't want a memory
[00:03:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=205s) system. Code is truth. Code is the
[00:03:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=207s) ground truth. It's also evolving and I
[00:03:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=210s) don't need another place that I need to
[00:03:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=212s) maintain. I already have a code base to
[00:03:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=214s) maintain. So for code, I don't need a
[00:03:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=215s) memory system, right?
[00:03:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=217s) >> Already endless bangers. I couldn't
[00:03:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=219s) agree more here. Even things like
[00:03:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=221s) comments often go out of date where a
[00:03:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=223s) comment is left in some code because it
[00:03:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=225s) has to do a certain thing a certain way.
[00:03:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=227s) The thing changes, the comment doesn't.
[00:03:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=228s) Now that comment isn't just like tech
[00:03:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=231s) dead in the sense that it's sitting
[00:03:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=232s) around doing nothing. It's now actively
[00:03:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=234s) harmful because it steers people and
[00:03:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=237s) agents the wrong way. Keeping your
[00:03:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=239s) context up to date and keeping your
[00:04:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=241s) information together and synced properly
[00:04:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=244s) is a real difficult challenge. And the
[00:04:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=248s) more you split up that knowledge, the
[00:04:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=250s) more split brain problems you end up
[00:04:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=252s) with where if you change something in
[00:04:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=253s) one place and you forget to change it in
[00:04:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=255s) all the others, everything falls apart.
[00:04:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=258s) And this is easier than ever in the AI
[00:04:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=260s) era because people will write these slop
[00:04:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=262s) markdown plan files, leave them in the
[00:04:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=265s) repo, and they go super out of date. I'm
[00:04:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=267s) even guilty of this with Lake Bet. I've
[00:04:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=269s) been meaning to go and trim out all of
[00:04:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=270s) those. It's so easy to context yourself
[00:04:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=273s) to hell if you let things that shouldn't
[00:04:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=276s) be in your context be there because
[00:04:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=278s) those will mislead the model with things
[00:04:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=280s) that haven't been true for sometimes
[00:04:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=281s) months or years even. models are really
[00:04:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=284s) good at kind of understanding the code
[00:04:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=286s) structure and the code style you have
[00:04:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=287s) just based on reading one or two files
[00:04:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=288s) and if you have that in order then you
[00:04:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=290s) don't need an HSMD for it to follow your
[00:04:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=292s) coding style or whatever and you might
[00:04:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=294s) give it a map of where things are which
[00:04:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=296s) is just a list of folders and short
[00:04:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=298s) descriptions that's fine that's easy to
[00:05:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=300s) maintain by the clanker itself but
[00:05:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=302s) anything above that like using
[00:05:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=303s) embeddings and using a and all that
[00:05:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=306s) stuff I mean you can if you want to
[00:05:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=310s) waste time but I'm pretty sure you've
[00:05:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=311s) never done an evaluation if that
[00:05:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=313s) actually produces better outputs and I
[00:05:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=314s) guarantee you it does not.
[00:05:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=316s) >> Yep. I have a silly way of verifying
[00:05:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=319s) that he is correct about this. Look at
[00:05:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=321s) Cursor. Whether or not you like or hate
[00:05:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=324s) Cursor, whether or not you like or hate
[00:05:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=325s) AI, I hope we can all agree that the
[00:05:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=328s) Cursor team knows what the [ __ ] they're
[00:05:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=331s) doing. Like, at the absolute least, in
[00:05:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=333s) particular, their ability to get models
[00:05:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=336s) to behave well in code bases is
[00:05:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=338s) unprecedented. And a lot of that back in
[00:05:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=340s) the day came from their crazy as and
[00:05:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=343s) their systems where they would get all
[00:05:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=345s) of the code base mapped in a way where
[00:05:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=347s) they could dynamically feed the right
[00:05:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=349s) context to the agent. Around this era,
[00:05:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=352s) Michael, the CEO of Kurser's favorite
[00:05:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=353s) thing to talk about is how context
[00:05:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=355s) windows are going to get bigger and
[00:05:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=356s) bigger until you can fit your whole
[00:05:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=358s) giant code base in the context of a
[00:06:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=360s) model and then it will know everything
[00:06:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=361s) and it'll make the right changes. It's
[00:06:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=363s) almost funny in retrospect because we've
[00:06:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=365s) went so far the other direction. But you
[00:06:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=368s) have to remember that a lot of the job
[00:06:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=370s) of cursor was to take these LLMs that at
[00:06:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=372s) the time just completed messages and
[00:06:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=375s) give them everything they needed in
[00:06:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=377s) order to make changes in a codebase.
[00:06:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=380s) Cursor was the company that got models
[00:06:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=382s) to to really do more with code. And at
[00:06:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=385s) that time the labs would work with
[00:06:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=387s) cursor to try and make their models work
[00:06:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=389s) better in that type of setup. And then
[00:06:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=391s) clad code happened and it proved that
[00:06:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=393s) the best solution here isn't giving all
[00:06:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=395s) of the context in this super fancy
[00:06:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=397s) dynamic graph-based system to the model.
[00:06:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=400s) Turns out if you just give it the tools
[00:06:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=402s) it needs and bash, it can find what it
[00:06:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=404s) needs relatively well. And once the
[00:06:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=406s) model started being trained to do that,
[00:06:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=408s) all of these dynamic fancy context
[00:06:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=410s) systems stop making sense. And even
[00:06:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=412s) cursor, who built like a lot of their
[00:06:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=414s) business around the code traversal [ __ ]
[00:06:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=417s) that they built, has entirely moved away
[00:06:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=419s) from that. like they just don't care
[00:07:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=421s) anymore. So if you think cursor is
[00:07:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=424s) entirely wrong about this move in a
[00:07:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=426s) space that they literally invented, then
[00:07:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=428s) sure, go make a fancy a to help your
[00:07:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=430s) model traverse your codebase via a fancy
[00:07:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=432s) graph instead of with bash tools. But if
[00:07:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=435s) you have any faith at all in the
[00:07:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=437s) industry, doing things that are better
[00:07:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=440s) because there's a reason for it, you
[00:07:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=442s) should probably drop all of that because
[00:07:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=444s) it just doesn't make sense anymore. It
[00:07:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=445s) just straight up doesn't. I wish it did.
[00:07:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=447s) Nope. It would be cool if there were
[00:07:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=449s) harder engineering problems to solve
[00:07:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=450s) here, but there just aren't. If you
[00:07:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=452s) build a fancy context management system,
[00:07:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=456s) instead of just giving the agent the
[00:07:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=457s) tools it needs to find [ __ ] you're
[00:07:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=459s) behind the curve now. You just are. It's
[00:07:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=461s) not real.
[00:07:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=461s) >> So for coding, don't need memory. I also
[00:07:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=464s) have my own Slack bot in that case. Uh
[00:07:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=466s) because again, I'm old. It's called mom
[00:07:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=469s) master of mischief because it's at the
[00:07:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=471s) root access to one of my servers and
[00:07:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=473s) there it has access to the entire
[00:07:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=477s) history of every channel it's in based
[00:07:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=479s) by using jq uh on JSONL file an append
[00:08:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=484s) only log basically of questions and
[00:08:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=486s) answers or prompts in the systems
[00:08:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=488s) responses and that basically gives gives
[00:08:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=490s) it infinite memory. I think
[00:08:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=492s) >> that is hilarious if you understand what
[00:08:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=495s) he just said he does here. So for his
[00:08:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=497s) custom chatbot he has in Slack that will
[00:08:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=499s) like come in and answer questions and
[00:08:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=501s) keep track of what's going on. He has it
[00:08:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=504s) write every input and output to a single
[00:08:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=506s) gigantic appendon JSON file and then he
[00:08:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=510s) has it set up so that it can use jq to
[00:08:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=512s) look things up and find things in there
[00:08:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=514s) instead of a memory system. It just has
[00:08:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=515s) literally everything that's ever
[00:08:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=517s) happened. I think that memory makes more
[00:08:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=519s) sense in chat contexts, especially with
[00:08:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=523s) how memory is improved in something like
[00:08:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=525s) chat GBT for example. It is impressive
[00:08:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=528s) that it can find the right thing in a
[00:08:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=531s) much less like wellmapped space than in
[00:08:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=534s) code. Like in a codebase, if I click a
[00:08:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=536s) button and it doesn't do what I expect,
[00:08:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=538s) you can programmatically trace from
[00:09:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=541s) where the button is that I clicked to
[00:09:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=543s) every other thing that gets touched. But
[00:09:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=545s) if I ask a question about my shoulder
[00:09:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=547s) hurting, it might be unintuitive that my
[00:09:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=550s) questions a month ago about keyboards
[00:09:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=552s) might be relevant because the new
[00:09:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=554s) keyboard I got might not be set up
[00:09:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=556s) properly or maybe the desk I bought is
[00:09:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=558s) too high and it's causing me to have bad
[00:09:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=559s) posture. There is no direct path from
[00:09:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=563s) one thing to the other in these more
[00:09:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=565s) human problems where there is a very
[00:09:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=567s) direct one in the code bases. So, I have
[00:09:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=570s) found that memory as a way of tagging
[00:09:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=572s) relevant information that is user
[00:09:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=575s) specific can be a little useful. And I'm
[00:09:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=578s) coming around from this as like the
[00:09:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=580s) anti-memory person that refused to put
[00:09:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=581s) memory in T3 chat that would talk a lot
[00:09:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=584s) of [ __ ] about how chatg did it because I
[00:09:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=587s) genuinely believe the memory
[00:09:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=588s) implementation in GPT40 resulted in
[00:09:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=592s) severe mental health damage to a lot of
[00:09:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=596s) people because once they got the model
[00:09:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=598s) working in a way where it was in its
[00:10:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=600s) like dangerous psychosis state the
[00:10:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=602s) memory would force it to stay there and
[00:10:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=604s) that's the part of memory I don't like
[00:10:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=606s) is when answers stop being useful
[00:10:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=608s) because they're too full of your
[00:10:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=609s) context. That is bad. And I've had this
[00:10:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=612s) even in my own general use of chat GPT.
[00:10:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=615s) I have found that sometimes when I ask a
[00:10:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=617s) question, it gets too into the weeds of
[00:10:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=619s) my own things I've asked for in the
[00:10:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=621s) past, and I'll often just say, "My
[00:10:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=623s) friend has this problem to get it to
[00:10:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=626s) stop pulling my memory in as
[00:10:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=627s) aggressively." Anyways, let's hear what
[00:10:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=629s) else our friends here have to say. I
[00:10:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=632s) think that loops back kind of to the pi
[00:10:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=634s) minimalism because around I don't know
[00:10:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=636s) July or August both me and Arlene
[00:10:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=638s) actually discovered through different uh
[00:10:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=641s) means that bash is all you need in the
[00:10:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=643s) sense that the models are inherently
[00:10:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=645s) trained to use bash now
[00:10:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=647s) >> bash basically is is a programming
[00:10:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=649s) language one but it is one anyways
[00:10:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=652s) >> and so the can just build its own stuff
[00:10:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=654s) and I think the the the interesting part
[00:10:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=655s) of like using pi or using a very very
[00:10:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=657s) very small like pi is interesting also
[00:10:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=659s) because it sort of extends itself as an
[00:11:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=661s) example, what do you want to connect it
[00:11:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=663s) to? Right? And so one of the things once
[00:11:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=665s) I connect it to is Sentry because like I
[00:11:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=667s) I have very useful data in Sentry, but I
[00:11:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=669s) don't use a Century MCP. Like I know
[00:11:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=671s) that David hates me for that, but I
[00:11:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=672s) don't use the Sentry MCP. I basically
[00:11:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=674s) went to to my coding agent and said
[00:11:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=676s) like, "Hey, we need this data from
[00:11:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=677s) Century." And I always need it in this
[00:11:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=679s) and this form. Let's build ourselves a
[00:11:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=681s) skill. And all the skill really is is
[00:11:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=683s) like here's a prompt that it can load on
[00:11:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=685s) demand, but it also encompasses it own
[00:11:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=687s) tools, right? And so um I solved the
[00:11:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=689s) authentication the way that I liked it.
[00:11:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=691s) I also pulled the data down in the form
[00:11:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=693s) that I usually wanted. And I think this
[00:11:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=696s) sort of like MCP versus tool situation
[00:11:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=698s) is a little bit weird because like at
[00:11:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=699s) the at the core of it, the file system
[00:11:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=702s) and like the tools themselves are one
[00:11:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=704s) thing, but the composability really is
[00:11:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=706s) the main one. How does my sentry skill
[00:11:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=708s) work in practice? where it pulls down a
[00:11:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=709s) bunch of JSON files, some of which it
[00:11:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=711s) loads in the context, but if it pulls
[00:11:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=712s) too much, I'm basically capping it and
[00:11:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=714s) saying like, hey, I showed you three
[00:11:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=716s) items, but I downloaded 52 into this
[00:11:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=718s) JSON file if I think the structure looks
[00:12:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=720s) correct and look into this JSON file,
[00:12:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=722s) right? So, it's basically this idea of
[00:12:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=724s) like how can I build tools that are very
[00:12:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=726s) very context efficient so that it can
[00:12:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=728s) then combine them together with other
[00:12:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=729s) things.
[00:12:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=730s) >> Not as strongly in agreement with that
[00:12:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=733s) part, but there are layers here that are
[00:12:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=734s) very good. I think people reach to make
[00:12:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=737s) skills a little bit too aggressively
[00:12:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=740s) overall. I also think they should have
[00:12:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=742s) touched on like the agent and claude MD
[00:12:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=745s) files a bit more here too. I have a lot
[00:12:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=747s) to say about that. So before I do it, I
[00:12:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=750s) want to read the post that led to
[00:12:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=751s) everybody linking this. The two authors
[00:12:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=753s) of PI share three design principles in
[00:12:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=755s) this three-minute video. First, coding
[00:12:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=757s) doesn't need a separate memory system.
[00:12:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=759s) Second, bash is all you need. And third,
[00:12:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=761s) load tool outputs into context only when
[00:12:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=764s) needed. If the tool output isn't needed,
[00:12:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=768s) then it shouldn't be a tool call. It
[00:12:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=770s) should be a bash call where it just
[00:12:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=773s) writes to a file and then cats part of
[00:12:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=776s) one of them. Like let the model do this
[00:12:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=779s) itself. I think that smart models,
[00:13:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=782s) especially like the recent crop, are
[00:13:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=784s) trained well enough to know how to not
[00:13:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=787s) overload their context. That's not our
[00:13:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=789s) problem. It's almost weird to have that
[00:13:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=792s) included here because like we shouldn't
[00:13:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=793s) have to think about those details.
[00:13:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=795s) First, I want to see just how much the
[00:13:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=797s) memory that I left on in Clawed Code is
[00:13:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=799s) screwing with me right now. And the
[00:13:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=801s) second is I want to show you how I think
[00:13:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=803s) about this overall slightly differently.
[00:13:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=804s) Okay, now that we're done with the
[00:13:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=805s) video, I can take off the headphones and
[00:13:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=807s) we can dig into my own world working
[00:13:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=810s) with T3 code. So, most of my work on T3
[00:13:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=812s) code is on this particular box, BB1.
[00:13:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=815s) It's my framework desktop. This box has
[00:13:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=819s) hundreds if not thousands of threads
[00:13:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=820s) that I've done with both Fable and Soul
[00:13:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=823s) on it with Cloud Code and with Codeex
[00:13:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=825s) respectively. And I've noticed recently
[00:13:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=828s) that Fable and Opus have been saving
[00:13:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=830s) things in memory and mentioning that a
[00:13:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=832s) lot. So one of those places to start is
[00:13:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=834s) to just ask what memories do you have of
[00:13:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=836s) this project? I want to understand what
[00:13:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=838s) memory has been stored throughout my
[00:14:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=840s) time working on T3 code with Cloud Code.
[00:14:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=842s) Let's see what it finds. Okay,
[00:14:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=844s) apparently on this box I only have one
[00:14:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=848s) memory from 9 days ago. It's a spec that
[00:14:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=851s) I was working on. I am very confused why
[00:14:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=854s) this random spec I was working on ended
[00:14:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=856s) up in memory. This is a feature that I'm
[00:14:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=858s) not even like actually planning on
[00:14:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=860s) shipping this like like we didn't get
[00:14:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=862s) very far in building it either. The fact
[00:14:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=864s) that this is the only thing stored in my
[00:14:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=865s) memory and that this is stored in memory
[00:14:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=867s) in the first place. Incredibly stupid. I
[00:14:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=870s) will ask on my own machine now. Now I'm
[00:14:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=873s) curious and a little annoyed. This will
[00:14:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=875s) be interesting. Interesting. I picked
[00:14:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=877s) one of the I have multiple clones of T3
[00:14:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=880s) code on this machine. So it looks like
[00:14:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=881s) it picked a random one deep in like the
[00:14:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=883s) cloud/ projects. That's to summarize all
[00:14:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=886s) the memories. It's actually really funny
[00:14:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=887s) that it included this cuz earlier I was
[00:14:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=889s) trying to set the output style to
[00:14:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=890s) concise in cloud code. It's a new
[00:14:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=892s) feature they just added and when I set
[00:14:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=894s) it, it didn't update the global file
[00:14:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=895s) which was really confusing and annoying
[00:14:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=897s) to me. Apparently, it decided to save
[00:14:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=899s) that as a memory. Lakebed has many
[00:15:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=903s) different memories saved across five
[00:15:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=906s) project directories. Railway topology,
[00:15:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=909s) locked work trees for long codex runs,
[00:15:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=911s) Lakewood file blob storage plan and it's
[00:15:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=913s) judged comparisons, V8 isolate layer
[00:15:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=916s) planning, launch audits, god file
[00:15:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=918s) cleanup refactors. Interesting.
[00:15:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=921s) Apparently T3 code again on this machine
[00:15:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=925s) has a hard rule to never touch preview
[00:15:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=928s) or production mobile builds. T3 connect
[00:15:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=930s) desktop already handles the full flow to
[00:15:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=933s) server baster race hazard. Huh. This is
[00:15:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=937s) garbage. Okay, this one's annoying
[00:15:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=939s) because I do the ping round
[00:15:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=941s) modernizations to test new models. So if
[00:15:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=944s) it is storing these things in memory,
[00:15:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=948s) that makes that test less pure and
[00:15:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=950s) really annoying. Benchmarks, I want LM
[00:15:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=953s) API calls configured minimally. Effort
[00:15:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=956s) only provider defaults. GBD56 effort is
[00:15:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=958s) a soft hint. Deep reasoning needs a dash
[00:16:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=961s) pro mode. Useless. None of this should
[00:16:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=962s) be saved here. This can change at any
[00:16:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=964s) time. And then other random projects. It
[00:16:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=966s) has context on my fork of moonlight. It
[00:16:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=969s) saved a bunch of things around the fish
[00:16:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=970s) slop rebuild, which is annoying. Again,
[00:16:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=972s) that's a benchmark. I do. It remembered
[00:16:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=974s) how I set up my bridge that keeps track
[00:16:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=977s) of the state of my washer and dryer in
[00:16:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=979s) Discord. Why is that saved in my memory?
[00:16:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=982s) CC usage pricing overrides.
[00:16:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=985s) None of this needs to be my [ __ ]
[00:16:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=987s) memory. This is pissing me off. Okay,
[00:16:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=989s) there we go. I have multiple clones of
[00:16:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=991s) T3 code on this box and the main one has
[00:16:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=994s) 45 memories. Remembers that I was
[00:16:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=997s) working on an onboarding overhaul. that
[00:16:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=999s) I was working on better babysit
[00:16:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1001s) monitoring flows in app that I had
[00:16:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1004s) drafts for the sidebar overhaul and
[00:16:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1006s) liked variant C. This is slop. All of
[00:16:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1010s) this is garbage. Realistically, how much
[00:16:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1012s) of the memory around T3 code you think
[00:16:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1014s) is actually useful? Let's see what it
[00:16:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1015s) has to say. Th this has broken me. I was
[00:16:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1019s) already kind of skeptical, but I hadn't
[00:17:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1021s) taken the time to look at what it was
[00:17:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1022s) doing. I'm going to go turn off memory
[00:17:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1025s) on cloud code across all of my machines
[00:17:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1029s) because this is [ __ ] useless. Should
[00:17:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1031s) I ask how often are memories actually
[00:17:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1032s) being used in sessions? I'll ask that
[00:17:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1033s) next because you have my curiosity.
[00:17:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1035s) Honest take maybe a third of it earns
[00:17:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1038s) its keep today. The 45 files store in
[00:17:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1040s) the main clone has three distinct decay
[00:17:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1042s) problems. First, we have the redundant
[00:17:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1045s) with agents MD. 10 files now dead
[00:17:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1048s) weight. Kill by pattern. Single origin
[00:17:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1050s) dev. No continuous animations. No sleep
[00:17:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1053s) pulling cloning real state with vacuum
[00:17:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1055s) into pairing URLs work tree ports all of
[00:17:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1058s) that graduated into agents MD which
[00:17:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1059s) every agent reads anyways. What's funny
[00:17:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1061s) is a lot of these things were in the
[00:17:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1062s) agent MD before the memory was created.
[00:17:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1064s) It just did that. Next categories
[00:17:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1067s) shipped feature designs 12 files mostly
[00:17:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1069s) expired per project environment modes
[00:17:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1072s) remote desktop updates open and editor
[00:17:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1075s) favicon fixes. Like why are specific PR
[00:17:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1077s) numbers finding their way in my [ __ ]
[00:17:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1079s) memory? That's enough of a reason to
[00:18:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1080s) know that this is garbage. There's a
[00:18:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1082s) bunch of point in time states that are
[00:18:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1084s) actively risky like monitor JSON schema
[00:18:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1086s) drift remote PR portfolio out of memory
[00:18:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1089s) crisis hut paths background policy scope
[00:18:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1092s) wiring gap cla probe test leak
[00:18:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1094s) processes. These describe a moment the
[00:18:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1096s) drift got migrated or didn't. The PR's
[00:18:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1099s) merged or didn't the leak got fixed or
[00:18:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1101s) didn't. Okay, a bunch of these aren't
[00:18:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1103s) durable. The fact that the version of
[00:18:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1105s) the GitHub CLI we were using on this
[00:18:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1107s) machine was out of date and I had to
[00:18:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1109s) update it is not something that should
[00:18:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1111s) be in my [ __ ] memory. I updated it.
[00:18:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1113s) The problem is solved. Go the [ __ ] away.
[00:18:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1115s) I don't need live plan URLs for
[00:18:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1117s) unshipped work. All of this is bad. One
[00:18:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1120s) of the memories on this machine is from
[00:18:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1122s) when I was trying to add Muse code
[00:18:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1124s) support to T3 code in my video. It saved
[00:18:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1127s) a bunch of [ __ ] here. Meta's Muse Code
[00:18:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1130s) CLI headless integration surface
[00:18:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1131s) discovered by probing mdash. No public
[00:18:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1134s) docs exist. Meta Muse code CLI Muse
[00:18:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1138s) self-updating bash launcher and SL local
[00:19:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1140s) bin version string Muse code yada yada
[00:19:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1143s) no public docs everything below is
[00:19:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1145s) discovered by probing on this date.
[00:19:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1147s) Headless mode multi-turn no ACP mode off
[00:19:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1150s) models related and it links to another
[00:19:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1152s) file. T3 connect desktop already
[00:19:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1155s) complete. How the [ __ ] is that related?
[00:19:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1157s) What? This is such slop. I feel like I'm
[00:19:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1160s) reading outputs from like the set three
[00:19:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1161s) hour. What the [ __ ] is this? This one
[00:19:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1164s) was because I raged because it overrode
[00:19:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1167s) one of the builds on my phone because it
[00:19:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1168s) reused a name for the build and I was
[00:19:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1171s) really annoyed. This is one of the many
[00:19:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1172s) reasons I switched to using soul for iOS
[00:19:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1173s) work. T3 Connect desktop already
[00:19:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1176s) completed. Either desktop can already do
[00:19:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1178s) the entire T3 Connect flow without the
[00:19:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1180s) CLI. Signin, link toggle, and relay
[00:19:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1182s) client installs are all in the bundled
[00:19:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1184s) web UI. Why is this in? Oh, I know why.
[00:19:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1187s) I was working on making the T3 Connect
[00:19:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1189s) CLI work on Mac as a background process.
[00:19:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1192s) And when I was working on that, I must
[00:19:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1194s) have had a problem where it was confused
[00:19:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1196s) because T3 Connect is supported inside
[00:19:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1198s) of T3 Code 2. So if you're running the
[00:20:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1200s) desktop app, you can control T3 Code
[00:20:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1202s) remotely on your phone. But if you want
[00:20:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1204s) to have it working as a background
[00:20:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1205s) process on like a Linux machine or on
[00:20:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1207s) like a Mac Mini that you don't even open
[00:20:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1209s) the app on, I wanted to set up the CLI
[00:20:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1211s) for that. We already have it on Linux.
[00:20:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1212s) We didn't have it on Mac OS. And at some
[00:20:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1214s) point in my back and forth specking this
[00:20:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1216s) out, it decided that it has to save in
[00:20:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1219s) memory for the desktop app has that
[00:20:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1221s) functionality. What the [ __ ] T3 Connect
[00:20:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1224s) multi-process hazard. Two T3 servers
[00:20:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1226s) sharing one base directory race over the
[00:20:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1229s) same environment identity, relay link,
[00:20:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1231s) and runtime state files. Who [ __ ]
[00:20:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1233s) cares?
[00:20:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1236s) It has a topology for how I use Railway.
[00:20:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1240s) As I can't help but notice that the
[00:20:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1242s) older memories don't have dates,
[00:20:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1244s) longunning codecs and agent builds in
[00:20:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1246s) the claude/work trees get autop pruned
[00:20:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1249s) midrun use locked work trees outside of
[00:20:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1252s) that directory.
[00:20:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1253s) Gross. Probably actually useful in here
[00:20:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1256s) otherwise though. Blob plan comparison.
[00:20:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1259s) Why did it save the comparison between
[00:21:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1262s) two plans that I did 3 months ago? I'm
[00:21:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1264s) just going to keep raging if I sit here
[00:21:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1266s) reading through it cuz like all of this
[00:21:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1268s) is slop. Okay, I'm going to have Fable
[00:21:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1270s) go across my fleet, disable memory and
[00:21:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1272s) cloud code across all of the machines,
[00:21:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1274s) archive the ones that I have, label them
[00:21:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1276s) correctly, and then delete the memories
[00:21:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1278s) because I have concluded this is
[00:21:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1279s) absolute [ __ ] garbage. I knew it
[00:21:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1281s) would be bad, but holy [ __ ] it is much
[00:21:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1283s) worse than I thought. Even funnier, the
[00:21:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1286s) memories get written far more than they
[00:21:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1287s) get read. Across every T3 code
[00:21:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1289s) transcript on this machine, there's over
[00:21:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1291s) 355 sessions just here. Only 19 of them
[00:21:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1296s) ever opened an individual memory file,
[00:21:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1298s) while 80 sessions wrote or edited them.
[00:21:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1300s) It's a 3 to one write to read. Of the 45
[00:21:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1303s) memories, 26 have never once been read.
[00:21:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1306s) Yeah, garbage. Useless. Okay, that's all
[00:21:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1310s) dying now for sure. I'm going to kill
[00:21:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1312s) literally all of that cuz I'm annoyed.
[00:21:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1314s) Holy [ __ ] My my war against memory
[00:21:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1316s) systems just ramped up massively. This
[00:21:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1318s) is so bad. Okay, so what do I do
[00:22:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1321s) instead? What is my way of thinking of
[00:22:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1323s) this that is so different that I feel
[00:22:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1325s) like it's worth talking about in a
[00:22:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1327s) video? There are multiple layers to this
[00:22:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1329s) and I'm going to continue using T3 code
[00:22:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1331s) for demonstrating it because I think
[00:22:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1332s) it's the easiest way to understand. The
[00:22:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1334s) two things we want out of better memory
[00:22:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1336s) context and all of this are less
[00:22:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1339s) mistakes. We want the agent to not do
[00:22:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1341s) stupid things that annoy us. We want to
[00:22:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1343s) steer it away from bad things and
[00:22:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1345s) towards good things. And second, more
[00:22:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1347s) directly, we want to feel like the model
[00:22:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1349s) is doing what we want without having to
[00:22:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1352s) tell it every detail. The less words and
[00:22:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1354s) less effort to get the model to do what
[00:22:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1356s) you want and behave how you want, the
[00:22:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1358s) better. I know these sound similar, but
[00:22:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1359s) they are different. Getting the model to
[00:22:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1361s) stop making mistakes when it shouldn't
[00:22:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1363s) have, and separately to behave the way
[00:22:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1365s) you want without being told exactly what
[00:22:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1368s) you want. These are different things,
[00:22:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1370s) and they're both important. People seem
[00:22:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1372s) to think memories will magically give
[00:22:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1373s) you both, and they don't. they just
[00:22:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1376s) straight up don't. So, how do we get
[00:22:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1377s) this instead? We can do the obvious
[00:22:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1379s) thing, which is to go into the agent MD
[00:23:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1381s) every time the model does something
[00:23:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1383s) wrong and add something small to it,
[00:23:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1386s) saying don't do this again. And that
[00:23:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1388s) does help. It does work. But at some
[00:23:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1389s) point you have to reflect and realize
[00:23:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1391s) that a lot of the issues the agent is
[00:23:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1394s) hitting are happening because of either
[00:23:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1396s) a difference in how you think about
[00:23:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1397s) things and how the agent thinks about
[00:23:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1399s) things or because the codebase is
[00:23:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1401s) architected in a way that's unintuitive
[00:23:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1402s) for the agent or there's some
[00:23:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1404s) communication gap between you and the
[00:23:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1405s) agent. There's all of these different
[00:23:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1408s) layers between you the code and the AI
[00:23:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1411s) working in it that can be these failure
[00:23:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1413s) cases. And my advice is often to take
[00:23:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1416s) one step back and find a way to
[00:23:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1418s) communicate not just what you don't want
[00:23:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1420s) the agent to do rather how you want the
[00:23:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1423s) agent to think about what it would do.
[00:23:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1426s) And I've been writing my agent and
[00:23:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1427s) claude MD files like this accordingly
[00:23:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1430s) because I think it helps a lot with
[00:23:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1432s) getting the model going in the
[00:23:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1434s) directions you want because there's
[00:23:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1436s) again there's the two sides. There is
[00:23:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1437s) preventing small annoying failures and
[00:24:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1440s) making sure you and the agent are moving
[00:24:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1442s) in the same direction together. And I
[00:24:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1443s) find that once you solve the latter,
[00:24:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1445s) when you make the agent more
[00:24:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1446s) directionally aligned with you and your
[00:24:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1448s) team, that you end up with way fewer of
[00:24:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1450s) these small annoying failure cases.
[00:24:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1452s) Potato Lauren, one of my favorite devs
[00:24:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1454s) from the React world who now is at
[00:24:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1456s) cursor and working on Grockbot and the
[00:24:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1458s) Pstack stuff. She's had a lot to say
[00:24:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1460s) here cuz she's been shipping an absolute
[00:24:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1462s) shitload of code. And I really like her
[00:24:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1464s) thinking of things here. And the order
[00:24:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1466s) of value in particular, I think is
[00:24:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1468s) really good. Every time you intervene
[00:24:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1469s) and correct your agent, you should think
[00:24:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1471s) about how to eliminate it entirely. It
[00:24:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1473s) being the thing that went wrong. Like
[00:24:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1475s) what can you do that prevents you from
[00:24:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1477s) having to intervene in the future? She
[00:24:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1478s) orders these in value. And I really like
[00:24:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1480s) that cuz you really should go through
[00:24:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1481s) these top to bottom and try to apply
[00:24:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1483s) them out of each layer until the problem
[00:24:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1486s) goes away. The best thing you can do
[00:24:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1487s) always is categorically eliminate the
[00:24:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1490s) problem through better architecture or
[00:24:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1492s) choice of data structures. This is a
[00:24:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1493s) thing I've been trying to do since way
[00:24:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1496s) before the AI era. It's why I loved
[00:24:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1498s) stuff like TRPC and I built the T3
[00:25:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1500s) stack. The amount of bugs that just
[00:25:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1502s) vanish when you adopt something like
[00:25:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1504s) that and the amount of potential
[00:25:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1506s) problems and technical complexity that
[00:25:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1507s) just doesn't exist anymore is magical. I
[00:25:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1510s) feel similar to convex and I think this
[00:25:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1511s) is why convex is so good for both humans
[00:25:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1513s) working in code bases and for agents.
[00:25:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1516s) There are many categories of failure
[00:25:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1517s) cases that can happen in a system where
[00:25:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1520s) all those pieces are architected
[00:25:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1522s) separately. convex or tRPC, the type
[00:25:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1525s) safety between the back end and the
[00:25:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1526s) front end removes those categories
[00:25:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1529s) entirely and it makes it much less
[00:25:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1530s) likely that you or a contributor makes a
[00:25:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1532s) mistake. And my efforts to make
[00:25:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1534s) codebases easier to contribute to for
[00:25:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1536s) devs of all skill levels, I ended up
[00:25:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1538s) inadvertently making them good for
[00:25:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1540s) agents as well. And it really does come
[00:25:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1541s) down to this. How can you technically
[00:25:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1545s) and through your actual direct
[00:25:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1546s) implementation of stuff fully remove
[00:25:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1549s) categories of potential failures from
[00:25:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1550s) your applications? An example outside of
[00:25:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1552s) the webdev world here would be something
[00:25:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1554s) like garbage collection or memory
[00:25:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1556s) safety. These solutions help you make
[00:25:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1559s) code that's more likely to work without
[00:26:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1561s) having to worry about all of these
[00:26:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1563s) edges. Somehow you're unable to do this
[00:26:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1565s) if this just fails outright, which it
[00:26:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1568s) can for many reasons. The next step is
[00:26:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1570s) to turn it into a lint rule or tests so
[00:26:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1572s) that CI can catch it. I have a real
[00:26:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1574s) example of this one actually. I care a
[00:26:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1577s) lot about the performance of T3 code. In
[00:26:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1580s) particular, I care a lot about how much
[00:26:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1583s) data needs to be transferred for you to
[00:26:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1585s) see a thread or get updates because when
[00:26:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1587s) I'm in an airplane with shitty Wi-Fi or
[00:26:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1589s) I'm on my phone on the go in a tunnel, I
[00:26:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1591s) want to be able to keep up with my
[00:26:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1592s) thread, even if I'm on 4G or even 3G
[00:26:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1595s) connections. And when I'm just getting
[00:26:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1597s) text data, it shouldn't be that much.
[00:26:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1599s) But as we added more and more features
[00:26:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1601s) to T3 code, that transit layer got more
[00:26:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1603s) and more bloated. And we got to the
[00:26:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1605s) point where we were sending tens of
[00:26:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1606s) megabytes down the wire over websockets
[00:26:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1608s) just to load a thread. And I crashed out
[00:26:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1610s) hard about this. I went and cleaned up
[00:26:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1613s) the transfers a ton. I set up a suite
[00:26:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1616s) locally so that I could see how my
[00:26:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1618s) changes affected what data was going
[00:27:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1620s) across and how much data was being used.
[00:27:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1621s) And then after I did all of this work,
[00:27:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1624s) regression started to happen almost
[00:27:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1625s) immediately. Within days of me fixing
[00:27:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1627s) this transit layer to make things more
[00:27:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1629s) efficient, regressions started to
[00:27:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1631s) happen. And I realized no matter how
[00:27:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1632s) much work I put into making this simpler
[00:27:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1635s) and better in the codebase, there will
[00:27:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1637s) always be potential failures. So instead
[00:27:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1639s) of continuing to eat those, I made a
[00:27:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1642s) change. I added a relatively complex
[00:27:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1645s) addition to the CI where I take these
[00:27:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1648s) sample threads from my realworld work
[00:27:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1650s) that are just massive piles of text and
[00:27:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1653s) I test for both codecs and claude doing
[00:27:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1655s) fake replays of these threads. How much
[00:27:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1658s) data actually goes over the websocket?
[00:27:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1660s) And once I got it to a place I was happy
[00:27:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1662s) with where instead of being tens or
[00:27:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1663s) hundreds of megs, it was consistently
[00:27:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1665s) under 100k for everything. It's under
[00:27:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1667s) 10K for most things. I decided to save
[00:27:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1669s) these numbers and make a PR that adds an
[00:27:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1673s) automatically commented action here that
[00:27:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1676s) tells you how much bandwidth each of
[00:27:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1678s) these do after your changes. And I have
[00:28:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1681s) a ceiling set here that's like 30%
[00:28:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1682s) higher than when I got all the
[00:28:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1684s) optimizations in. So if any changes push
[00:28:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1686s) us at or over this line, PR fails, I am
[00:28:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1689s) notified. I come in and say, "What the
[00:28:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1691s) [ __ ] are you doing?" This has already
[00:28:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1693s) prevented real regressions. And what
[00:28:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1695s) I've noticed is my agents don't bug me
[00:28:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1697s) until they fix them. So now when I make
[00:28:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1699s) a change that affects the data layer and
[00:28:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1701s) that change causes a regression, the
[00:28:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1704s) agent fixes it before it tells me it's
[00:28:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1705s) done. I love it. It's so nice like using
[00:28:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1708s) these techniques I have built over the
[00:28:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1710s) better part of two decades to keep my
[00:28:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1713s) teammates and keep my businesses, the
[00:28:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1715s) companies I work for and all of that
[00:28:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1717s) from regressing the work I put in. Now I
[00:28:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1719s) can whip that together for my agents and
[00:28:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1721s) it serves the same purpose, arguably
[00:28:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1722s) even better. So I agree like if you
[00:28:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1725s) can't write the code in a way that
[00:28:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1727s) prevents other people or agents from
[00:28:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1729s) making these mistakes, the best next
[00:28:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1731s) step is to rule it out entirely with
[00:28:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1733s) lint rules, with CI, with custom tests,
[00:28:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1735s) send to end, whatever you have to do,
[00:28:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1736s) make it so the agent can figure out the
[00:28:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1738s) thing sucks before it bothers you about
[00:29:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1740s) it. If both of these fail, and I always
[00:29:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1743s) say like if you were to put gaps in
[00:29:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1744s) these, first one you should always do
[00:29:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1746s) and you should do the [ __ ] out of it. If
[00:29:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1748s) somehow it fails, try again and again.
[00:29:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1751s) And if you conclude there is no way for
[00:29:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1753s) you to programmatically structure things
[00:29:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1755s) to prevent these types of failures, then
[00:29:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1758s) hesitantly introduce lint rules or CI to
[00:29:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1760s) fix it. This should be enough to fix
[00:29:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1762s) almost all things. If somehow it isn't,
[00:29:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1765s) reflect and try again. It probably still
[00:29:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1767s) is. If somehow after all that it still
[00:29:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1769s) isn't, breathe a heavy sigh and accept
[00:29:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1772s) that you are in that small bucket where
[00:29:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1774s) a skill or a rule might actually be
[00:29:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1777s) beneficial. I find that these are less
[00:29:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1779s) useful for things that have to do with
[00:29:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1782s) the code and are more useful for things
[00:29:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1784s) with the process around it. Like if I
[00:29:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1786s) want to expose the server I'm working on
[00:29:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1789s) remotely so I can connect over tail
[00:29:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1790s) scale, a skill for that is helpful. But
[00:29:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1792s) skills should be a fallback that you
[00:29:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1795s) fall into when the codebase can't solve
[00:29:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1798s) the problem and the lint rules in CI
[00:30:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1801s) also can't. Skills shouldn't be this
[00:30:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1803s) thing you reach for all the time to
[00:30:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1805s) build this crazy set of skills that will
[00:30:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1807s) solve all your problems. They are a
[00:30:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1809s) safety net. They are a fallback. You
[00:30:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1810s) should treat them accordingly. And if
[00:30:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1812s) somehow all of these things fail,
[00:30:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1814s) introduce a human into the loop to
[00:30:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1816s) check. You should not have to do this.
[00:30:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1818s) You get the point though. I really like
[00:30:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1820s) Lauren's way of framing these things.
[00:30:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1821s) And I think you can see what I mean. If
[00:30:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1823s) you look at my projects and you look at
[00:30:25](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1825s) T3 code and see how we've architected
[00:30:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1827s) it, what we have done and how we're
[00:30:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1829s) building it. One of the main hesitations
[00:30:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1831s) we have right now, for example, with the
[00:30:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1832s) T3 code Swift UI rewrite is that we lose
[00:30:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1836s) a lot of our structure that prevents
[00:30:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1838s) regressions in the mobile app because we
[00:30:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1840s) use the same shared TypeScript code for
[00:30:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1843s) all the data loading between the web
[00:30:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1845s) app, the Electron desktop app, and the
[00:30:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1847s) React Native mobile app. Since all three
[00:30:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1849s) of those data layers are exactly the
[00:30:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1851s) same, it is basically impossible for us
[00:30:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1853s) to make a change that breaks one of them
[00:30:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1856s) and not the other two. So, it's much
[00:30:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1857s) easier to make changes safely. I've
[00:31:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1860s) already had the Swift UI app regress
[00:31:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1862s) because that relationship is not as
[00:31:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1864s) clearly encoded. And sometimes the
[00:31:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1866s) compromises are this big. Like, I have
[00:31:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1867s) an app that I feel is better that we
[00:31:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1870s) aren't merging because it causes
[00:31:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1872s) codebased drift that would allow for
[00:31:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1874s) these types of failures to exist where
[00:31:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1876s) right now they can't. I just saw a quote
[00:31:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1878s) from chat that I really like. I do not
[00:31:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1880s) know this was an Uncle Bob quote. It's
[00:31:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1881s) probably a mistake to impose human
[00:31:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1883s) discipline on an agent, but it's not a
[00:31:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1886s) mistake to impose human values on the
[00:31:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1888s) agent. That is such a banger. I love
[00:31:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1890s) this new era agentic uncle Bob so much.
[00:31:33](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1893s) Even when I have told them to do
[00:31:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1894s) test-driven development at high
[00:31:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1896s) discipline, they always fall back on
[00:31:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1898s) doing that. They always end up doing
[00:31:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1900s) that. So, I figure that's probably okay.
[00:31:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1904s) So the bottom line there is it's
[00:31:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1906s) probably a mistake to impose a human
[00:31:49](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1909s) discipline on an agent. It is not a
[00:31:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1912s) mistake to impose human values
[00:31:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1916s) on the agent, but there may be
[00:31:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1918s) thresholds that we need to change, but
[00:32:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1920s) the disciplines themselves, the
[00:32:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1922s) behaviors, I don't think it's wise to
[00:32:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1924s) impose those.
[00:32:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1925s) >> That's a lovely way of phrasing it. I
[00:32:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1926s) really like that.
[00:32:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1928s) >> God, I I'm going to flip a [ __ ] [ __ ]
[00:32:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1930s) on [clears throat] this one when I watch
[00:32:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1931s) it later. Every single word that Uncle
[00:32:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1934s) Bob has been saying about Agentic Dev
[00:32:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1935s) stuff recently is so on point. It is a
[00:32:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1938s) little frustrating to me that he could
[00:32:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1940s) go from being like slightly to
[00:32:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1942s) meaningfully behind on a lot of his
[00:32:23](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1943s) takes to ahead of the vast majority of
[00:32:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1947s) the industry in like 3 months. It's been
[00:32:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1949s) wild to watch. I fully endorse
[00:32:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1952s) everything he just said here and I'm so
[00:32:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1954s) excited to watch the rest of this. I'm
[00:32:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1955s) saving it to my watch later. I'd
[00:32:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1956s) recommend you guys watch it, too. Uncle
[00:32:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1958s) Bob gets it. Somebody has mentioned in
[00:32:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1959s) chat that I have the least generic agent
[00:32:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1962s) MD files and I'm going to take the
[00:32:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1965s) opportunity now to share one of them.
[00:32:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1967s) I've talked about this one a little bit
[00:32:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1968s) in the past. I'll talk about a bit more
[00:32:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1970s) here. This is the T3 code agent MD. I
[00:32:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1973s) describe the pieces that matter first
[00:32:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1974s) and foremost, what it is, and then how
[00:32:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1977s) it works. I start quickly about how the
[00:33:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1980s) node websocket server wraps provider
[00:33:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1982s) CLIs in order to serve the different
[00:33:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1984s) platforms. This is a really simple
[00:33:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1986s) concise way of saying all of the parts
[00:33:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1988s) that matter and then calling out here
[00:33:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1990s) that you can think of T3 code as an open
[00:33:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1991s) source bring your own subscription
[00:33:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1992s) alternative to apps like cloud desktop
[00:33:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1994s) codeex app cursor glass and conductor.
[00:33:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1996s) This is the context for everything it
[00:33:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1997s) needs to know about what it is. You
[00:33:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=1999s) might be confused why it would need to
[00:33:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2000s) know that because it's just writing the
[00:33:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2001s) code, right? Have you ever had an
[00:33:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2002s) engineer on your team that doesn't
[00:33:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2004s) actually understand the product? I have.
[00:33:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2006s) It's not fun. Having claude coder codecs
[00:33:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2009s) understand T3 code means that they are
[00:33:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2012s) more likely to suggest things and make
[00:33:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2014s) changes and stay aligned directionally
[00:33:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2016s) with me. On that note, the what makes T3
[00:33:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2019s) code special section is very much
[00:33:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2022s) keeping this in mind because I want to
[00:33:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2024s) make sure the people contributing to T3
[00:33:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2026s) code and the agents they're using to
[00:33:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2028s) write those contributions are aligned
[00:33:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2030s) and trying to move in the same
[00:33:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2031s) direction. The that includes things like
[00:33:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2033s) open at the core. I want to make sure T3
[00:33:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2035s) code stays open. So if any of the
[00:33:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2038s) suggestions a model might make would
[00:33:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2039s) involve me close sourcing some portion,
[00:34:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2041s) they probably shouldn't do that. And I
[00:34:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2043s) have had my models suggest this in the
[00:34:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2045s) past that this is fine because the code
[00:34:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2047s) won't be seen. And I have to remind it,
[00:34:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2049s) no, this code is open. We're not close
[00:34:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2050s) sourcing parts. And it's like, oh, okay,
[00:34:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2053s) I guess we'll do it this other way then.
[00:34:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2054s) This removed all of that. Performance
[00:34:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2056s) without compromise. It's a silly
[00:34:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2058s) addition, but it does result in the
[00:34:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2060s) models thinking a bit more about how the
[00:34:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2062s) changes affect performance. It's silly,
[00:34:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2064s) but this change here affected the amount
[00:34:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2068s) of regressions we saw in data loading
[00:34:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2070s) more than any of the systemic changes I
[00:34:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2072s) made in the actual code side. Obviously,
[00:34:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2074s) my code changes to improve it were the
[00:34:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2076s) best, but the regressions kept happening
[00:34:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2078s) because of the agents. This reduced a
[00:34:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2080s) lot of them and then my CI cleaned up
[00:34:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2081s) the rest. Remote ready. This one's
[00:34:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2083s) important because a lot of the time if
[00:34:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2084s) the model doesn't know that we care a
[00:34:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2086s) lot about the remote experience, it will
[00:34:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2088s) make something that works great locally
[00:34:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2090s) and even test it with the Electron app
[00:34:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2092s) locally and say, "Oh yeah, this all
[00:34:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2093s) works great." And then I connect with my
[00:34:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2095s) phone or I connect over the web and it
[00:34:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2096s) fails. So I make sure it is very clear
[00:34:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2098s) we want every change to work well with
[00:35:00](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2100s) the remote connections. And along that I
[00:35:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2103s) add the multi-urface section clarifying
[00:35:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2105s) what services we have and that we have
[00:35:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2107s) to care a lot about them and make sure
[00:35:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2109s) changes work across all of them as we
[00:35:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2111s) expect. I have a personal note for me
[00:35:13](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2113s) after I like adding these to my agent
[00:35:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2115s) MDs just to help with the tone and the
[00:35:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2117s) context, but most importantly again this
[00:35:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2119s) directionality thing. I want to make
[00:35:21](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2121s) sure the model and I are working towards
[00:35:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2124s) a similar goal and taking similar paths
[00:35:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2126s) and these little notes help a lot. I
[00:35:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2128s) also needed a good place to stak this
[00:35:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2130s) piece about not killing the T3 code
[00:35:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2132s) server when I'm working on T3 code in T3
[00:35:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2134s) code and this felt like a decent place
[00:35:35](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2135s) to put it. I added a glossery and I find
[00:35:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2137s) these help a ton. Glosseries do a great
[00:35:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2140s) job of helping the agent and the people
[00:35:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2142s) working with it have a shared language
[00:35:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2144s) to make sure we can go back and forth
[00:35:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2146s) and understand what each other are
[00:35:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2148s) saying. It also helps with Claude's
[00:35:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2150s) thing where it just makes up these fancy
[00:35:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2152s) terms for [ __ ] that doesn't need to. I
[00:35:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2154s) have a section on things that the model
[00:35:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2155s) kept doing no matter what I did that I
[00:35:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2157s) wanted to have stop. These are the ways
[00:35:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2159s) it would literally kill the running
[00:36:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2161s) server which were obnoxious. This fixes
[00:36:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2163s) most of them. Then I have the hit every
[00:36:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2164s) surface section because I was tired of
[00:36:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2166s) changes being applied on web and then
[00:36:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2169s) not on mobile and then mobile breaking.
[00:36:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2170s) This section is a good reminder. Make
[00:36:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2172s) sure this works everywhere. This has
[00:36:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2174s) helped a lot with keeping platforms in
[00:36:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2176s) sync. A section about dev servers
[00:36:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2178s) because the dev server stuff in T3 code
[00:36:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2180s) is meaningfully complex. a section about
[00:36:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2182s) test data because I wanted to make it
[00:36:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2184s) easier to clone my data for my real use
[00:36:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2186s) cases over to a work tree so that I can
[00:36:29](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2189s) work on this and like check and validate
[00:36:31](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2191s) my changes with real data more reliably.
[00:36:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2194s) A verification section where I call out
[00:36:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2196s) to not run all these giant repo wide
[00:36:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2197s) checks all the time unless it's asked.
[00:36:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2200s) Pull requests and how to file them. I
[00:36:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2202s) think this part's really helpful too.
[00:36:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2203s) Just making sure the titles are actually
[00:36:45](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2205s) readable. A really brief where code
[00:36:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2207s) lives. Not that it actually matters.
[00:36:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2208s) Probably the least useful thing within
[00:36:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2210s) this. And then a taste section. This is
[00:36:52](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2212s) mostly when Julius gets mad at me at
[00:36:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2214s) things that my slop code does. I add
[00:36:57](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2217s) them here to keep steering in the
[00:36:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2219s) direction that makes Julius happy. He
[00:37:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2221s) really likes the adapter boundary being
[00:37:03](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2223s) where complexity lives so that the
[00:37:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2224s) orchestration can be really simple and
[00:37:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2226s) the UI can be really stupid. We both
[00:37:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2228s) hate any types and annotations that are
[00:37:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2229s) unnecessary. We prefer inferred.
[00:37:11](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2231s) Comments should describe how a thing is
[00:37:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2232s) used and they should move when the code
[00:37:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2234s) moves. To be used mostly to describe
[00:37:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2235s) functions, not to annotate every line of
[00:37:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2237s) behavior. It's been very helpful. Your
[00:37:19](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2239s) agents should understand you well enough
[00:37:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2242s) to reasonably copy what you would do. If
[00:37:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2246s) you aren't already at the point where
[00:37:27](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2247s) you ask an agent to do a thing and
[00:37:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2250s) you're surprised at how well it
[00:37:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2252s) understands you and what you want where
[00:37:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2254s) maybe you tell it to do this one small
[00:37:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2256s) thing and it says, "Wait, wouldn't you
[00:37:38](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2258s) also want it for these three other
[00:37:40](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2260s) things?" It's a little more complex and
[00:37:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2261s) you're like, "Wait, yeah, I did want
[00:37:43](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2263s) that. I would have went and done that
[00:37:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2264s) right after." If you don't find yourself
[00:37:47](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2267s) in that spot often, you haven't tuned
[00:37:50](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2270s) these things well enough yet. I'm
[00:37:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2271s) regularly surprised by my agents going
[00:37:54](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2274s) further than I expect but entirely in
[00:37:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2275s) the direction I want or pushing back on
[00:37:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2278s) me in ways that I would have had to
[00:37:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2279s) figure out the hard way later and they
[00:38:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2281s) did not do that much by default. They do
[00:38:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2282s) it a lot now and it's these files and
[00:38:05](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2285s) it's certainly not the [ __ ] memory.
[00:38:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2286s) In fact, they probably hurt. I'm really
[00:38:07](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2287s) excited to have it cleaned out. This one
[00:38:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2288s) was quite a journey. We started with
[00:38:10](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2290s) memory systems and all the things I hate
[00:38:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2292s) about them to me crashing out at my own
[00:38:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2294s) memories and my own projects and then
[00:38:16](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2296s) going through and gutting all of that to
[00:38:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2298s) my agent MD to Uncle Bob and all these
[00:38:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2300s) other things. I try to have a
[00:38:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2302s) cohesiveish conclusion at the end of
[00:38:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2304s) these and I'll do my best to here. The
[00:38:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2306s) main thing I want you to take away here
[00:38:28](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2308s) is that your end goal should be that you
[00:38:30](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2310s) and your agent are working in such lock
[00:38:32](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2312s) step that you're regularly surprised by
[00:38:34](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2314s) how well it seems like it understands
[00:38:36](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2316s) you. And that is a thing you have to
[00:38:37](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2317s) build because every time you start a new
[00:38:39](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2319s) thread, the agent's brain is wiped out.
[00:38:41](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2321s) That doesn't mean we need automatic
[00:38:42](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2322s) memories to keep it fresh and up to
[00:38:44](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2324s) date. They're actually worse than that.
[00:38:46](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2326s) They make it bad. What we really want is
[00:38:48](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2328s) to make sure that on Groundhog Day when
[00:38:51](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2331s) the model wakes up and starts that it
[00:38:53](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2333s) has all the things that matter to you in
[00:38:55](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2335s) its head so that it's more likely to go
[00:38:56](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2336s) where you want it to go. Take the
[00:38:58](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2338s) opportunity to get a little more
[00:38:59](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2339s) personal with how you talk to your
[00:39:01](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2341s) agents both when you're prompting and
[00:39:02](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2342s) also when you're building these types of
[00:39:04](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2344s) context systems. Help the model
[00:39:06](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2346s) understand you and what you want and
[00:39:08](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2348s) you'll be surprised at how well it can
[00:39:09](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2349s) work alongside that. I have been blown
[00:39:12](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2352s) away at what is possible with these
[00:39:14](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2354s) slight changes to these things and I
[00:39:15](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2355s) have a feeling you will be too. Give it
[00:39:17](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2357s) a shot and let me know how it goes in
[00:39:18](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2358s) the comments. Until next time, burn that
[00:39:20](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2360s) memory off. Seriously though, the memory
[00:39:22](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2362s) in quad code is so bad. I everyone
[00:39:24](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2364s) should be turning that off. I I have
[00:39:26](https://www.youtube.com/watch?v=Jf54k7tFeEc&t=2366s) some rants to do. Bards.
