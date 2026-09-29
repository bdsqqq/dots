# Write Code You Will Never Read Again

source: https://www.youtube.com/watch?v=434cG4g5KLE
youtube upload_date (UTC): 20260722
duration: 00:24:11
captions: youtube automatic, en-orig; not human-verified.
speaker changes, proper names, and punctuation may be wrong.
timestamps are caption start times; no editorial summarization.

[00:00:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=0s) Every once in a while when I decide I
[00:00:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=1s) want to film a video, I realize that
[00:00:03](https://www.youtube.com/watch?v=434cG4g5KLE&t=3s) there's almost no benefit to me because
[00:00:05](https://www.youtube.com/watch?v=434cG4g5KLE&t=5s) the video is going to frustrate both
[00:00:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=7s) sides of the argument. This is
[00:00:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=9s) definitely one of those cases because I
[00:00:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=11s) want to talk about how much of your code
[00:00:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=12s) you should be reading. I'm so scared to
[00:00:15](https://www.youtube.com/watch?v=434cG4g5KLE&t=15s) say this next part that I'm just going
[00:00:16](https://www.youtube.com/watch?v=434cG4g5KLE&t=16s) to put it on the screen instead. I think
[00:00:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=18s) this is the case for the vast vast
[00:00:20](https://www.youtube.com/watch?v=434cG4g5KLE&t=20s) majority of engineers. Whether you're
[00:00:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=22s) building slop side projects or you're
[00:00:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=24s) building really important infrastructure
[00:00:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=26s) that powers the world or medical devices
[00:00:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=28s) that keep people alive, I think that the
[00:00:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=30s) percentage of code you're reading is
[00:00:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=32s) probably too high. It could also be too
[00:00:35](https://www.youtube.com/watch?v=434cG4g5KLE&t=35s) low, but for the most part, I think a
[00:00:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=37s) lot of people, especially those who
[00:00:38](https://www.youtube.com/watch?v=434cG4g5KLE&t=38s) think their code is so so important, are
[00:00:41](https://www.youtube.com/watch?v=434cG4g5KLE&t=41s) reading way too much. But there's
[00:00:43](https://www.youtube.com/watch?v=434cG4g5KLE&t=43s) another side here that I think's even
[00:00:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=45s) more important. You're not generating
[00:00:46](https://www.youtube.com/watch?v=434cG4g5KLE&t=46s) enough code yet. In many ways, that's
[00:00:49](https://www.youtube.com/watch?v=434cG4g5KLE&t=49s) actually the more important piece and I
[00:00:51](https://www.youtube.com/watch?v=434cG4g5KLE&t=51s) think you'll understand after we talk
[00:00:53](https://www.youtube.com/watch?v=434cG4g5KLE&t=53s) about this for a bit. This video concept
[00:00:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=55s) came from a tweet I made a few days ago.
[00:00:57](https://www.youtube.com/watch?v=434cG4g5KLE&t=57s) How much better do the models have to
[00:00:59](https://www.youtube.com/watch?v=434cG4g5KLE&t=59s) get before you'll stop reading the code?
[00:01:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=61s) And the answer to this should not be as
[00:01:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=62s) direct as many people seem to think.
[00:01:05](https://www.youtube.com/watch?v=434cG4g5KLE&t=65s) This is going to be quite a video and if
[00:01:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=66s) I do it right, you should be able to
[00:01:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=67s) come out of it with a better idea of how
[00:01:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=69s) to get as much value as possible out of
[00:01:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=71s) AI-generated code. But first, a quick
[00:01:13](https://www.youtube.com/watch?v=434cG4g5KLE&t=73s) break for today's sponsor. Setting up
[00:01:15](https://www.youtube.com/watch?v=434cG4g5KLE&t=75s) off for your users is pretty easy as
[00:01:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=77s) long as your users aren't agents or
[00:01:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=78s) enterprises. Then it gets hairy fast.
[00:01:20](https://www.youtube.com/watch?v=434cG4g5KLE&t=80s) Thankfully, we have WorkOS to smooth out
[00:01:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=82s) those rough edges. They really
[00:01:23](https://www.youtube.com/watch?v=434cG4g5KLE&t=83s) understand what enterprises need for
[00:01:25](https://www.youtube.com/watch?v=434cG4g5KLE&t=85s) off, but that doesn't mean they're
[00:01:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=86s) compromising on the developer
[00:01:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=87s) experience. They still have all of the
[00:01:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=88s) things you would expect from a modern
[00:01:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=90s) off service through off kit, their
[00:01:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=91s) package system for getting the UI and
[00:01:33](https://www.youtube.com/watch?v=434cG4g5KLE&t=93s) connections necessary to set up off
[00:01:35](https://www.youtube.com/watch?v=434cG4g5KLE&t=95s) across every different framework you
[00:01:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=97s) would possibly want to use. Your agents
[00:01:38](https://www.youtube.com/watch?v=434cG4g5KLE&t=98s) will be able to figure it out just fine.
[00:01:39](https://www.youtube.com/watch?v=434cG4g5KLE&t=99s) Their enterprise offerings are where
[00:01:40](https://www.youtube.com/watch?v=434cG4g5KLE&t=100s) they've historically shined because they
[00:01:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=102s) have everything a business needs up for
[00:01:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=104s) your service and businesses have a lot
[00:01:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=105s) of very specific needs, including the
[00:01:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=107s) admin portal which makes it trivial for
[00:01:49](https://www.youtube.com/watch?v=434cG4g5KLE&t=109s) you to send a link to the IT team at the
[00:01:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=110s) company you're trying to get to sign up
[00:01:52](https://www.youtube.com/watch?v=434cG4g5KLE&t=112s) for your service so they can onboard
[00:01:53](https://www.youtube.com/watch?v=434cG4g5KLE&t=113s) themselves. If you want a company's
[00:01:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=115s) agents to be able to register for your
[00:01:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=116s) service, The new standard Auth MD, which
[00:01:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=118s) has been pioneered by WorkOS, is
[00:02:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=120s) probably your best bet. It's the first
[00:02:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=121s) standard I've seen that actually makes
[00:02:03](https://www.youtube.com/watch?v=434cG4g5KLE&t=123s) sense for agents and will make it
[00:02:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=124s) possible for your users to sign up
[00:02:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=126s) without actually having to do it
[00:02:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=127s) themselves. This is why companies like
[00:02:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=128s) Cloudflare, Firecall, Resend, Monday,
[00:02:10](https://www.youtube.com/watch?v=434cG4g5KLE&t=130s) and more have already adopted this new
[00:02:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=132s) standard. Get your app ready for users,
[00:02:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=134s) agents, and businesses at
[00:02:15](https://www.youtube.com/watch?v=434cG4g5KLE&t=135s) swade.link/workos.
[00:02:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=137s) Now that my first statement has
[00:02:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=138s) absolutely destroyed the comment
[00:02:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=139s) section, let's start talking about
[00:02:21](https://www.youtube.com/watch?v=434cG4g5KLE&t=141s) what's actually up here. Going to start
[00:02:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=142s) with my favorite aspect This is meant to
[00:02:25](https://www.youtube.com/watch?v=434cG4g5KLE&t=145s) be the importance of code spectrum.
[00:02:29](https://www.youtube.com/watch?v=434cG4g5KLE&t=149s) And on one side here we have like slop
[00:02:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=152s) website with one viewer. And on the
[00:02:35](https://www.youtube.com/watch?v=434cG4g5KLE&t=155s) other side we have, I don't know, I'll
[00:02:38](https://www.youtube.com/watch?v=434cG4g5KLE&t=158s) say firmware for pacemaker. How about
[00:02:39](https://www.youtube.com/watch?v=434cG4g5KLE&t=159s) that? No one can argue that the firmware
[00:02:41](https://www.youtube.com/watch?v=434cG4g5KLE&t=161s) on your pacemaker, the thing that keeps
[00:02:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=162s) your heart beating, isn't really
[00:02:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=164s) important and that a mistake on that
[00:02:46](https://www.youtube.com/watch?v=434cG4g5KLE&t=166s) would be really bad because it would
[00:02:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=167s) literally kill people. All software kind
[00:02:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=170s) of fits somewhere on this spectrum and I
[00:02:52](https://www.youtube.com/watch?v=434cG4g5KLE&t=172s) don't want to pretend otherwise. I feel
[00:02:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=175s) like the narrative around AI code and
[00:02:57](https://www.youtube.com/watch?v=434cG4g5KLE&t=177s) whether or not you should read it and
[00:02:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=178s) verify and all of this is kind of
[00:03:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=180s) plagued by this spectrum and people
[00:03:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=182s) thinking it matters more than it does
[00:03:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=184s) because everybody is somewhere on here
[00:03:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=186s) and if you want to be real, the code I
[00:03:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=187s) write is not particularly far down it.
[00:03:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=189s) Like I likely am in this range depending
[00:03:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=192s) on how you want to define it, if it's
[00:03:13](https://www.youtube.com/watch?v=434cG4g5KLE&t=193s) exponential or not, whatever. I don't
[00:03:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=194s) care. I will gladly say Theo's code is
[00:03:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=197s) nowhere near as important as the
[00:03:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=199s) firmware on a pacemaker. What I've
[00:03:21](https://www.youtube.com/watch?v=434cG4g5KLE&t=201s) noticed is that a lot of people seem to
[00:03:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=202s) think they're further along the line
[00:03:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=204s) than they are but more importantly, they
[00:03:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=206s) think really, really negatively about
[00:03:29](https://www.youtube.com/watch?v=434cG4g5KLE&t=209s) everything below them on this line. So
[00:03:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=211s) whenever somebody makes a statement
[00:03:33](https://www.youtube.com/watch?v=434cG4g5KLE&t=213s) about AI generated code, the developer
[00:03:36](https://www.youtube.com/watch?v=434cG4g5KLE&t=216s) who hears it will think about where they
[00:03:38](https://www.youtube.com/watch?v=434cG4g5KLE&t=218s) are on the spectrum and if they like the
[00:03:39](https://www.youtube.com/watch?v=434cG4g5KLE&t=219s) statement, they'll assume that the
[00:03:41](https://www.youtube.com/watch?v=434cG4g5KLE&t=221s) person who's talking is where they are
[00:03:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=222s) or better. And if they don't like the
[00:03:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=224s) statement, they'll assume the person is
[00:03:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=225s) where they are or below, probably below.
[00:03:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=227s) This makes the conversation here nearly
[00:03:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=230s) impossible because everybody is thinking
[00:03:53](https://www.youtube.com/watch?v=434cG4g5KLE&t=233s) too highly of themselves and more
[00:03:54](https://www.youtube.com/watch?v=434cG4g5KLE&t=234s) importantly thinks that the code they
[00:03:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=236s) write matters way more than it does. I
[00:03:59](https://www.youtube.com/watch?v=434cG4g5KLE&t=239s) could sit here and argue all day with
[00:04:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=240s) the people who are arguing against me
[00:04:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=242s) because they think their code is so
[00:04:03](https://www.youtube.com/watch?v=434cG4g5KLE&t=243s) important. And what would I know? I
[00:04:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=244s) generate wrappers for LLMs. Doesn't
[00:04:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=246s) matter that I built video infrastructure
[00:04:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=248s) for years before that. But that aside, I
[00:04:10](https://www.youtube.com/watch?v=434cG4g5KLE&t=250s) don't want to have these arguments. I'm
[00:04:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=252s) going to do a thing that I don't need to
[00:04:13](https://www.youtube.com/watch?v=434cG4g5KLE&t=253s) do. I'm going to presume the important
[00:04:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=257s) code people are correct. I don't have to
[00:04:21](https://www.youtube.com/watch?v=434cG4g5KLE&t=261s) do this. I think these people are
[00:04:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=262s) [ __ ] full of themselves and most of
[00:04:23](https://www.youtube.com/watch?v=434cG4g5KLE&t=263s) them are stupid, but I don't want to
[00:04:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=266s) argue that because that's not the point
[00:04:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=268s) I want to make. We are presuming the
[00:04:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=270s) people who are saying every line of code
[00:04:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=272s) is important are being real. So let's
[00:04:35](https://www.youtube.com/watch?v=434cG4g5KLE&t=275s) dig into that statement. Every line of
[00:04:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=277s) code is important in my work. We'll
[00:04:40](https://www.youtube.com/watch?v=434cG4g5KLE&t=280s) assume this is true. Every line of code
[00:04:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=282s) that is being written, being put into a
[00:04:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=284s) PR, being committed, being compiled,
[00:04:46](https://www.youtube.com/watch?v=434cG4g5KLE&t=286s) being shipped is so important that
[00:04:48](https://www.youtube.com/watch?v=434cG4g5KLE&t=288s) people could literally die if you get it
[00:04:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=290s) wrong. I'll even go that far.
[00:04:52](https://www.youtube.com/watch?v=434cG4g5KLE&t=292s) If one line is wrong, people could die.
[00:04:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=295s) In this case, I agree. If this is the
[00:04:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=298s) case for the projects you're working on,
[00:05:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=300s) you absolutely should be reading every
[00:05:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=302s) line of code that gets shipped. But
[00:05:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=304s) here's the other harsh reality I want
[00:05:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=306s) you to consider. Code is useful for
[00:05:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=308s) things other than shipping. If your code
[00:05:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=311s) is so important that you need to be sure
[00:05:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=314s) every single line is correct, maybe you
[00:05:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=317s) could use more code that is less
[00:05:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=319s) important to verify the important code.
[00:05:21](https://www.youtube.com/watch?v=434cG4g5KLE&t=321s) There is no person alive where 100% of
[00:05:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=324s) the code they write is mission critical
[00:05:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=326s) because if it is, they're not good at
[00:05:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=328s) their job because you need to work on
[00:05:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=330s) other things to
[00:05:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=332s) hone your skills, to keep learning, to
[00:05:35](https://www.youtube.com/watch?v=434cG4g5KLE&t=335s) keep growing. But also, you can write
[00:05:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=337s) code that is a little less important to
[00:05:39](https://www.youtube.com/watch?v=434cG4g5KLE&t=339s) verify the code that is so important.
[00:05:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=342s) Let's talk about how things used to be.
[00:05:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=345s) I'm just going to make up numbers for
[00:05:46](https://www.youtube.com/watch?v=434cG4g5KLE&t=346s) this, but the percentages are going to
[00:05:48](https://www.youtube.com/watch?v=434cG4g5KLE&t=348s) line up with what my experience was like
[00:05:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=350s) in the past. Let's say in a given day
[00:05:52](https://www.youtube.com/watch?v=434cG4g5KLE&t=352s) back when I worked at Twitch, I would
[00:05:54](https://www.youtube.com/watch?v=434cG4g5KLE&t=354s) read, I don't know, let's say a thousand
[00:05:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=356s) lines of code a day. This is a thousand
[00:05:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=358s) lines of code I would read. Let's say I
[00:06:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=360s) would write, I don't know, let's say I
[00:06:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=362s) would write 200 or so. So I would write
[00:06:05](https://www.youtube.com/watch?v=434cG4g5KLE&t=365s) 200 lines of code and then through
[00:06:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=366s) reading that, referencing other code,
[00:06:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=368s) doing code reviews and everything else,
[00:06:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=371s) I would read a thousand lines and I
[00:06:13](https://www.youtube.com/watch?v=434cG4g5KLE&t=373s) would write 200. This made a lot of
[00:06:15](https://www.youtube.com/watch?v=434cG4g5KLE&t=375s) sense in the world, but writing code was
[00:06:16](https://www.youtube.com/watch?v=434cG4g5KLE&t=376s) expensive and all the code we merged was
[00:06:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=378s) important. So we had to take the time to
[00:06:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=382s) read a ton of code others were writing
[00:06:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=384s) cuz every time somebody wrote a line of
[00:06:25](https://www.youtube.com/watch?v=434cG4g5KLE&t=385s) code in hopes of getting it into prod,
[00:06:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=387s) at least two people should read it
[00:06:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=388s) before we give it a thumbs up and merge
[00:06:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=390s) it or everything's going to slowly fall
[00:06:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=391s) apart. This has changed. Whether or not
[00:06:34](https://www.youtube.com/watch?v=434cG4g5KLE&t=394s) we want to admit it, this has changed.
[00:06:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=397s) If it hasn't changed for you yet, you
[00:06:39](https://www.youtube.com/watch?v=434cG4g5KLE&t=399s) are not very good at your job right now.
[00:06:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=402s) Period. Hear me out. Let's add one more
[00:06:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=405s) metric here. We'll say that I read a
[00:06:46](https://www.youtube.com/watch?v=434cG4g5KLE&t=406s) thousand lines, I wrote 200, and let's
[00:06:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=410s) say out of that 200, only 100 of them
[00:06:53](https://www.youtube.com/watch?v=434cG4g5KLE&t=413s) were good enough to merge. This ratio of
[00:06:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=416s) two to one for my written code is not
[00:06:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=418s) too bad. 200 lines written for every 100
[00:07:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=421s) worth merging, acceptable-ish.
[00:07:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=424s) Let's presume you are similar to me and
[00:07:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=426s) you're working on projects that are
[00:07:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=428s) somewhat important, but like if they
[00:07:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=429s) break, you can just revert and it's
[00:07:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=431s) fine. This has changed a lot in that
[00:07:13](https://www.youtube.com/watch?v=434cG4g5KLE&t=433s) case. Nowadays, I find myself reading
[00:07:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=437s) maybe roughly the same amount of code,
[00:07:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=439s) but I have to move this to the side now
[00:07:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=442s) because it's more complex. I might read
[00:07:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=444s) a thousand lines of code a day, but
[00:07:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=447s) I'm generating 2000 plus. So I might be
[00:07:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=451s) reading a good bit, but I'm generating
[00:07:33](https://www.youtube.com/watch?v=434cG4g5KLE&t=453s) way more. And what I merge has
[00:07:35](https://www.youtube.com/watch?v=434cG4g5KLE&t=455s) increased. It's increased a meaningful
[00:07:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=457s) amount. We'll say it's 500 lines of code
[00:07:40](https://www.youtube.com/watch?v=434cG4g5KLE&t=460s) being merged a day. We're kind of in
[00:07:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=462s) danger because there's a lot of code
[00:07:43](https://www.youtube.com/watch?v=434cG4g5KLE&t=463s) here that is being generated
[00:07:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=467s) that is not being read, and that's
[00:07:49](https://www.youtube.com/watch?v=434cG4g5KLE&t=469s) scary.
[00:07:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=470s) Except for the fact that most of this
[00:07:51](https://www.youtube.com/watch?v=434cG4g5KLE&t=471s) code that is being generated is not
[00:07:54](https://www.youtube.com/watch?v=434cG4g5KLE&t=474s) being put up for code review. It's not
[00:07:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=476s) being merged. It's not being used for
[00:07:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=478s) much of anything other than testing
[00:07:59](https://www.youtube.com/watch?v=434cG4g5KLE&t=479s) ideas. This did not used to make sense
[00:08:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=482s) because back in my day when I learned
[00:08:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=484s) how to code by hand, every line of code
[00:08:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=486s) took time. So, writing a shitload of
[00:08:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=488s) code to do one quick thing never made
[00:08:10](https://www.youtube.com/watch?v=434cG4g5KLE&t=490s) sense. If you wanted to get an answer to
[00:08:13](https://www.youtube.com/watch?v=434cG4g5KLE&t=493s) a question about your users,
[00:08:15](https://www.youtube.com/watch?v=434cG4g5KLE&t=495s) you might have to write 100 lines of
[00:08:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=497s) code that you would stuff into the
[00:08:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=498s) product to do new analytics. And then
[00:08:20](https://www.youtube.com/watch?v=434cG4g5KLE&t=500s) you have to write another 20 or 30 lines
[00:08:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=502s) of SQL in order to get the answer later
[00:08:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=504s) on.
[00:08:25](https://www.youtube.com/watch?v=434cG4g5KLE&t=505s) That was
[00:08:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=506s) obnoxious, but if the question was
[00:08:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=508s) important enough, you could do it. The
[00:08:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=510s) reality is that code is way cheaper now.
[00:08:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=512s) You should be generating more code than
[00:08:34](https://www.youtube.com/watch?v=434cG4g5KLE&t=514s) you were before because code is so
[00:08:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=517s) goddamn cheap. And now we get into the
[00:08:40](https://www.youtube.com/watch?v=434cG4g5KLE&t=520s) stupid pushback that a lot of people
[00:08:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=522s) have. If you're able to slop this amount
[00:08:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=524s) of code, your product isn't that
[00:08:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=525s) important, and that's okay. I'm sorry,
[00:08:48](https://www.youtube.com/watch?v=434cG4g5KLE&t=528s) layer. You are incredibly wrong here.
[00:08:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=530s) Nev asked, "I write code for a financial
[00:08:52](https://www.youtube.com/watch?v=434cG4g5KLE&t=532s) ERP system. Mistakes in this code could
[00:08:54](https://www.youtube.com/watch?v=434cG4g5KLE&t=534s) be converted to huge losses for my
[00:08:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=536s) companies who use this ERP system. Is my
[00:08:59](https://www.youtube.com/watch?v=434cG4g5KLE&t=539s) code important?" Probably, but you
[00:09:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=541s) should be writing way more code.
[00:09:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=544s) Hear me out. If your code is so goddamn
[00:09:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=547s) important that every single line needs
[00:09:10](https://www.youtube.com/watch?v=434cG4g5KLE&t=550s) to be verified because it could bankrupt
[00:09:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=552s) businesses, it could get people killed,
[00:09:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=554s) it could stop people's hearts, it could
[00:09:16](https://www.youtube.com/watch?v=434cG4g5KLE&t=556s) drive cars into walls, if your code is
[00:09:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=559s) that important, you should be writing an
[00:09:21](https://www.youtube.com/watch?v=434cG4g5KLE&t=561s) unbelievable amount of slop. Not to put
[00:09:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=564s) in your product, but to verify your
[00:09:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=566s) product. Every line of code that goes in
[00:09:29](https://www.youtube.com/watch?v=434cG4g5KLE&t=569s) should have 100 lines of slop verifying
[00:09:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=571s) it. Every line that goes in should have
[00:09:34](https://www.youtube.com/watch?v=434cG4g5KLE&t=574s) 10,000 lines of code of slop that you
[00:09:36](https://www.youtube.com/watch?v=434cG4g5KLE&t=576s) can use to verify the system. You should
[00:09:38](https://www.youtube.com/watch?v=434cG4g5KLE&t=578s) be building custom debuggers. You should
[00:09:40](https://www.youtube.com/watch?v=434cG4g5KLE&t=580s) be building custom runtimes that you can
[00:09:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=582s) run your stuff in to verify them. You
[00:09:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=584s) should be building the tools to
[00:09:46](https://www.youtube.com/watch?v=434cG4g5KLE&t=586s) guarantee the thing you care so much
[00:09:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=587s) about keeps working. You cannot convince
[00:09:51](https://www.youtube.com/watch?v=434cG4g5KLE&t=591s) me that your code is so important that
[00:09:54](https://www.youtube.com/watch?v=434cG4g5KLE&t=594s) AI can't touch it, but it's not
[00:09:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=596s) important enough to build verification
[00:09:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=598s) systems. Oh, but our verification
[00:10:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=600s) systems are so important. Those need to
[00:10:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=601s) have every line of code checked, too.
[00:10:03](https://www.youtube.com/watch?v=434cG4g5KLE&t=603s) Okay, abstract one layer higher then. If
[00:10:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=606s) the core of your code is too important
[00:10:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=607s) for AI to touch and the layer around it
[00:10:10](https://www.youtube.com/watch?v=434cG4g5KLE&t=610s) is too important for AI to touch, then
[00:10:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=612s) build one more on top of that. Build
[00:10:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=614s) tools that introspect all of the runs
[00:10:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=617s) that all of your testing tools are
[00:10:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=618s) using. If you don't have a custom
[00:10:20](https://www.youtube.com/watch?v=434cG4g5KLE&t=620s) debugger for your software yet, you're
[00:10:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=622s) not slopping hard enough. If you don't
[00:10:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=624s) have custom logging systems tracking all
[00:10:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=626s) the things that matter on top of the
[00:10:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=627s) vetted ones you already wrote by hand,
[00:10:29](https://www.youtube.com/watch?v=434cG4g5KLE&t=629s) you're not slopping hard enough. If your
[00:10:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=632s) code is so goddamn important that you
[00:10:34](https://www.youtube.com/watch?v=434cG4g5KLE&t=634s) talk [ __ ] on people for only reading 10
[00:10:36](https://www.youtube.com/watch?v=434cG4g5KLE&t=636s) to 20% of the code they generate in a
[00:10:38](https://www.youtube.com/watch?v=434cG4g5KLE&t=638s) given day, you're not doing your job
[00:10:40](https://www.youtube.com/watch?v=434cG4g5KLE&t=640s) well.
[00:10:41](https://www.youtube.com/watch?v=434cG4g5KLE&t=641s) Period.
[00:10:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=642s) And I know this because I know a lot of
[00:10:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=644s) the people working on these types of
[00:10:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=645s) systems. Imagine how many lives will be
[00:10:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=647s) ruined by doing this. Please elaborate,
[00:10:49](https://www.youtube.com/watch?v=434cG4g5KLE&t=649s) Kotek. I'm listening.
[00:10:51](https://www.youtube.com/watch?v=434cG4g5KLE&t=651s) How does building sloppy debugging tools
[00:10:54](https://www.youtube.com/watch?v=434cG4g5KLE&t=654s) to use on top of the existing processes
[00:10:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=656s) you already have
[00:10:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=658s) hurt anyone? Please explain. Shoutout
[00:11:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=660s) says 80% of the code he generates goes
[00:11:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=662s) into test harnesses and guardrails and
[00:11:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=664s) the LM has access to the results of the
[00:11:05](https://www.youtube.com/watch?v=434cG4g5KLE&t=665s) harnesses, which results in way less
[00:11:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=667s) mistakes. That's a great way to do it.
[00:11:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=669s) And if you write your code by hand or
[00:11:10](https://www.youtube.com/watch?v=434cG4g5KLE&t=670s) you review that code by hand, even if
[00:11:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=672s) you review the test by hand, awesome.
[00:11:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=674s) I'm cool with all of that. My argument
[00:11:15](https://www.youtube.com/watch?v=434cG4g5KLE&t=675s) isn't that you shouldn't read all the
[00:11:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=677s) code you write. Let's Let's flip this a
[00:11:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=679s) bit to be a little clearer about what I
[00:11:20](https://www.youtube.com/watch?v=434cG4g5KLE&t=680s) mean here. Let's say you're one of the
[00:11:21](https://www.youtube.com/watch?v=434cG4g5KLE&t=681s) people who writes this really important
[00:11:23](https://www.youtube.com/watch?v=434cG4g5KLE&t=683s) code and we'll say that you write,
[00:11:25](https://www.youtube.com/watch?v=434cG4g5KLE&t=685s) review, and verify 100 LLC a day. This
[00:11:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=687s) code is super, super important and this
[00:11:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=690s) is all you wrote. You wrote the 100
[00:11:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=691s) lines, you verified the 100 lines, these
[00:11:33](https://www.youtube.com/watch?v=434cG4g5KLE&t=693s) 100 lines can get people killed, they're
[00:11:34](https://www.youtube.com/watch?v=434cG4g5KLE&t=694s) really, really important. So, you didn't
[00:11:36](https://www.youtube.com/watch?v=434cG4g5KLE&t=696s) write any additional code, you didn't
[00:11:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=697s) read or review any additional code. This
[00:11:39](https://www.youtube.com/watch?v=434cG4g5KLE&t=699s) was your whole day. I am not saying that
[00:11:41](https://www.youtube.com/watch?v=434cG4g5KLE&t=701s) you should reduce the number of lines of
[00:11:43](https://www.youtube.com/watch?v=434cG4g5KLE&t=703s) code you read. If you write 100 lines of
[00:11:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=705s) code and you also read, let's say you
[00:11:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=707s) read a bit more. Let's say previously
[00:11:49](https://www.youtube.com/watch?v=434cG4g5KLE&t=709s) you would write 100 lines and you would
[00:11:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=710s) read 200 lines. 100 lines of code
[00:11:53](https://www.youtube.com/watch?v=434cG4g5KLE&t=713s) written and verified and 200 lines of
[00:11:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=716s) code were read. If this is the case for
[00:11:59](https://www.youtube.com/watch?v=434cG4g5KLE&t=719s) you, this should not change. What I
[00:12:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=721s) would say is today you should still
[00:12:05](https://www.youtube.com/watch?v=434cG4g5KLE&t=725s) write and hand verify 100 lines of code.
[00:12:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=727s) Like, don't change that. This is code is
[00:12:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=729s) really important. Keep doing that. Maybe
[00:12:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=731s) it even goes down a little bit. Maybe
[00:12:13](https://www.youtube.com/watch?v=434cG4g5KLE&t=733s) you only have time in the day to do 80
[00:12:15](https://www.youtube.com/watch?v=434cG4g5KLE&t=735s) lines of code written and verified now.
[00:12:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=737s) It's unfortunate, but I know that's the
[00:12:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=738s) case for a lot of people. Let's say
[00:12:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=739s) you're Sadly, you can only write 80% of
[00:12:21](https://www.youtube.com/watch?v=434cG4g5KLE&t=741s) the code you wrote before, but now
[00:12:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=744s) you review 400 lines of code instead,
[00:12:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=747s) but you generate and this is the
[00:12:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=748s) difference. This is the thing I really
[00:12:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=750s) need you guys to understand.
[00:12:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=751s) You now generate
[00:12:33](https://www.youtube.com/watch?v=434cG4g5KLE&t=753s) 800 lines of code. And this 800 lines of
[00:12:36](https://www.youtube.com/watch?v=434cG4g5KLE&t=756s) code is absolute [ __ ] slop and you
[00:12:39](https://www.youtube.com/watch?v=434cG4g5KLE&t=759s) don't touch this in your actual product.
[00:12:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=762s) This 800 lines of code sits in another
[00:12:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=764s) repo or at the very least some other
[00:12:46](https://www.youtube.com/watch?v=434cG4g5KLE&t=766s) [ __ ] up directory in your important
[00:12:48](https://www.youtube.com/watch?v=434cG4g5KLE&t=768s) repos. And all it does is explores. It
[00:12:51](https://www.youtube.com/watch?v=434cG4g5KLE&t=771s) verifies assumptions. It tests those 80
[00:12:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=775s) lines before in all of the crazy ways
[00:12:57](https://www.youtube.com/watch?v=434cG4g5KLE&t=777s) that were never worth it before because
[00:12:59](https://www.youtube.com/watch?v=434cG4g5KLE&t=779s) writing a thousand lines of code to make
[00:13:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=781s) sure one line of code works how it's
[00:13:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=782s) expected to never made sense before. I
[00:13:05](https://www.youtube.com/watch?v=434cG4g5KLE&t=785s) am not telling people that they need to
[00:13:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=787s) change how they verify the code that
[00:13:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=789s) goes into prod. I'm not saying you need
[00:13:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=792s) to merge slop into your projects. I am
[00:13:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=794s) saying that if you are of the belief
[00:13:16](https://www.youtube.com/watch?v=434cG4g5KLE&t=796s) that your code is so god damn important
[00:13:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=799s) that every line needs to be read or
[00:13:20](https://www.youtube.com/watch?v=434cG4g5KLE&t=800s) people will die, then you're not writing
[00:13:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=802s) enough code yet. You're just not
[00:13:23](https://www.youtube.com/watch?v=434cG4g5KLE&t=803s) generating enough. That's all I am
[00:13:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=806s) saying. If you put a little time into
[00:13:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=808s) realizing that code is useful for things
[00:13:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=810s) other than merging, it's useful for
[00:13:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=812s) things other than updating your product,
[00:13:34](https://www.youtube.com/watch?v=434cG4g5KLE&t=814s) code can do so much [ __ ] I have like
[00:13:36](https://www.youtube.com/watch?v=434cG4g5KLE&t=816s) 10,000 lines of JavaScript I wrote on my
[00:13:39](https://www.youtube.com/watch?v=434cG4g5KLE&t=819s) Windows computer just for organizing
[00:13:41](https://www.youtube.com/watch?v=434cG4g5KLE&t=821s) files. That never made sense before.
[00:13:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=824s) Writing 10,000 lines of code for a
[00:13:46](https://www.youtube.com/watch?v=434cG4g5KLE&t=826s) couple bespoke asset movements. Like I
[00:13:48](https://www.youtube.com/watch?v=434cG4g5KLE&t=828s) think I maybe moved like 100 assets with
[00:13:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=830s) it. 10,000 lines of code to organize 100
[00:13:52](https://www.youtube.com/watch?v=434cG4g5KLE&t=832s) files is mental illness until the code
[00:13:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=835s) is free to generate. Then all of a
[00:13:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=836s) sudden it's totally reasonable. And this
[00:13:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=838s) is the thing people haven't internalized
[00:14:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=840s) yet. They are correct that AI code is
[00:14:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=842s) cheap. They are correct that AI code is
[00:14:05](https://www.youtube.com/watch?v=434cG4g5KLE&t=845s) bad. They are correct that AI code could
[00:14:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=847s) get people killed if it's not verified
[00:14:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=848s) properly. They are incorrect that code
[00:14:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=851s) is expensive still. And if you can't
[00:14:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=854s) find ways to use this cheap infinite
[00:14:16](https://www.youtube.com/watch?v=434cG4g5KLE&t=856s) code generating system to verify your
[00:14:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=859s) existing systems, you are not a very
[00:14:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=862s) creative engineer. The fact that code
[00:14:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=864s) can be generated on a whim for any
[00:14:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=866s) theory, for any question, for any
[00:14:29](https://www.youtube.com/watch?v=434cG4g5KLE&t=869s) problem you want to verify, for any step
[00:14:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=871s) you want to debug, for anything, is a
[00:14:33](https://www.youtube.com/watch?v=434cG4g5KLE&t=873s) magical thing. And it absolutely sucks
[00:14:36](https://www.youtube.com/watch?v=434cG4g5KLE&t=876s) that we don't get to experience this as
[00:14:39](https://www.youtube.com/watch?v=434cG4g5KLE&t=879s) end users because most people are
[00:14:41](https://www.youtube.com/watch?v=434cG4g5KLE&t=881s) letting AI code just generate slop and
[00:14:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=884s) they're too lazy to check it. And I
[00:14:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=885s) agree that's a problem. And I am with
[00:14:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=887s) you that should be stopped. Important
[00:14:49](https://www.youtube.com/watch?v=434cG4g5KLE&t=889s) systems need more care and craft with
[00:14:53](https://www.youtube.com/watch?v=434cG4g5KLE&t=893s) the code going into them. But now we
[00:14:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=895s) have a tool we can use to verify it
[00:14:57](https://www.youtube.com/watch?v=434cG4g5KLE&t=897s) harder, to check it more. I never used
[00:15:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=900s) to write custom lint rules. I wrote
[00:15:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=901s) maybe one or two in my life. Now I
[00:15:03](https://www.youtube.com/watch?v=434cG4g5KLE&t=903s) generate custom lint rules all the time.
[00:15:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=906s) I didn't used to make custom debug
[00:15:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=908s) tools. I would rely on the ones that
[00:15:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=909s) existed in the browser. Now I will build
[00:15:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=911s) my own one-off debuggers and systems and
[00:15:13](https://www.youtube.com/watch?v=434cG4g5KLE&t=913s) compiler hooks that add a bunch of stuff
[00:15:15](https://www.youtube.com/watch?v=434cG4g5KLE&t=915s) into my react code to try and see how it
[00:15:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=917s) performs better. When I was testing how
[00:15:20](https://www.youtube.com/watch?v=434cG4g5KLE&t=920s) much load my systems could handle, I
[00:15:21](https://www.youtube.com/watch?v=434cG4g5KLE&t=921s) would have to hit up friends and like
[00:15:23](https://www.youtube.com/watch?v=434cG4g5KLE&t=923s) put together these complex tests. Now I
[00:15:25](https://www.youtube.com/watch?v=434cG4g5KLE&t=925s) just tell Codex, "Hey, you have access
[00:15:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=927s) to AWS. Go spin up a bunch of [ __ ] and
[00:15:29](https://www.youtube.com/watch?v=434cG4g5KLE&t=929s) stress test the system so I can get a
[00:15:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=931s) better idea of how much traffic I can
[00:15:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=932s) handle." The power of unlimited code is
[00:15:35](https://www.youtube.com/watch?v=434cG4g5KLE&t=935s) hard [snorts] to fathom. And if you're
[00:15:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=937s) still thinking of code in that small box
[00:15:40](https://www.youtube.com/watch?v=434cG4g5KLE&t=940s) that is so important, I get why you're
[00:15:43](https://www.youtube.com/watch?v=434cG4g5KLE&t=943s) struggling to make this jump. But you
[00:15:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=945s) need to realize important code is only
[00:15:48](https://www.youtube.com/watch?v=434cG4g5KLE&t=948s) part of your day-to-day. And if 90% of
[00:15:51](https://www.youtube.com/watch?v=434cG4g5KLE&t=951s) the code that you're touching in a given
[00:15:52](https://www.youtube.com/watch?v=434cG4g5KLE&t=952s) day is that important, you're just not
[00:15:54](https://www.youtube.com/watch?v=434cG4g5KLE&t=954s) touching enough code yet. And when your
[00:15:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=956s) life had to be that way because every
[00:15:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=958s) line of code was so important people
[00:16:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=960s) could die, that got so ingrained in your
[00:16:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=962s) head, as it should, because if it
[00:16:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=964s) doesn't people die. That era is over
[00:16:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=966s) now.
[00:16:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=967s) I'm not saying move faster. I'm not
[00:16:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=969s) saying merge slop. All I am saying is
[00:16:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=972s) that everybody can benefit some amount
[00:16:15](https://www.youtube.com/watch?v=434cG4g5KLE&t=975s) from the infinite code generator that we
[00:16:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=977s) now all have access to on bedrock, on
[00:16:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=979s) it, Codex, on Claude code, on whatever.
[00:16:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=982s) I'm not telling you to make your code
[00:16:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=984s) cheaper.
[00:16:25](https://www.youtube.com/watch?v=434cG4g5KLE&t=985s) I'm telling you to make more cheap code.
[00:16:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=987s) And that's a huge difference. And there
[00:16:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=988s) are a ton of creative ways you can do
[00:16:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=990s) this. If you're still reading all of the
[00:16:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=992s) code, you're not generating enough of
[00:16:34](https://www.youtube.com/watch?v=434cG4g5KLE&t=994s) it. I'm not saying you should verify
[00:16:35](https://www.youtube.com/watch?v=434cG4g5KLE&t=995s) less code than you used to. I'm saying
[00:16:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=997s) you should write more code than you used
[00:16:38](https://www.youtube.com/watch?v=434cG4g5KLE&t=998s) to. And you should be writing so much
[00:16:40](https://www.youtube.com/watch?v=434cG4g5KLE&t=1000s) code that a lot of it isn't worth human
[00:16:43](https://www.youtube.com/watch?v=434cG4g5KLE&t=1003s) attention. Reading code takes energy and
[00:16:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=1005s) effort and time, and it should. We
[00:16:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=1007s) shouldn't try to find ways to read code
[00:16:49](https://www.youtube.com/watch?v=434cG4g5KLE&t=1009s) faster. We shouldn't try to find ways to
[00:16:51](https://www.youtube.com/watch?v=434cG4g5KLE&t=1011s) merge unsafe things quicker. We should
[00:16:53](https://www.youtube.com/watch?v=434cG4g5KLE&t=1013s) be finding ways to make the code we care
[00:16:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=1015s) the most about better, faster. Let's
[00:16:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=1018s) think about code in a funnel, top to
[00:17:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=1021s) bottom, where the majority of code is at
[00:17:03](https://www.youtube.com/watch?v=434cG4g5KLE&t=1023s) the top and a very small percentage is
[00:17:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=1024s) at the bottom. This is meant to be a
[00:17:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=1026s) funnel of importance. There will always
[00:17:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=1027s) be more code that is garbage than code
[00:17:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=1029s) that is super important, and this gap is
[00:17:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=1031s) going to widen rapidly over time. The
[00:17:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=1034s) top here I will clearly label as such, I
[00:17:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=1037s) would rather die than have anyone read
[00:17:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=1038s) this code. It's code that doesn't
[00:17:20](https://www.youtube.com/watch?v=434cG4g5KLE&t=1040s) matter. It's code like the 10,000 lines
[00:17:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=1042s) I wrote to organize assets on my
[00:17:23](https://www.youtube.com/watch?v=434cG4g5KLE&t=1043s) computer. I accidentally read 10 lines
[00:17:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=1046s) of it once. It's such slop that I'm
[00:17:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=1047s) offended that I did. No one should have
[00:17:29](https://www.youtube.com/watch?v=434cG4g5KLE&t=1049s) to read the slop. Nobody should have to
[00:17:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=1050s) read the [ __ ] people are generating
[00:17:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=1052s) on lovable for their like pet stores.
[00:17:34](https://www.youtube.com/watch?v=434cG4g5KLE&t=1054s) And I agree there. And if you don't
[00:17:36](https://www.youtube.com/watch?v=434cG4g5KLE&t=1056s) perceive a difference between that and
[00:17:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=1057s) the code inside of a pacemaker, you are
[00:17:39](https://www.youtube.com/watch?v=434cG4g5KLE&t=1059s) making my job harder here because I'm
[00:17:41](https://www.youtube.com/watch?v=434cG4g5KLE&t=1061s) trying to be realistic here. But there's
[00:17:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=1062s) stops between and these stops are
[00:17:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=1065s) valuable. It's I'll frame these as I'd
[00:17:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=1067s) like for this to work in the middle tier
[00:17:49](https://www.youtube.com/watch?v=434cG4g5KLE&t=1069s) and I might and I'll get fired if it
[00:17:53](https://www.youtube.com/watch?v=434cG4g5KLE&t=1073s) doesn't work for the tier below. I think
[00:17:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=1075s) this roughly represents the tiers I
[00:17:57](https://www.youtube.com/watch?v=434cG4g5KLE&t=1077s) think of code in. At the very top,
[00:18:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=1080s) there's slop. At the very bottom,
[00:18:03](https://www.youtube.com/watch?v=434cG4g5KLE&t=1083s) there's death. And in between is where
[00:18:05](https://www.youtube.com/watch?v=434cG4g5KLE&t=1085s) most of us actually live. The vast
[00:18:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=1087s) majority of people watching, their code
[00:18:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=1088s) falls between this range. Where the
[00:18:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=1092s) code's important enough that like you'd
[00:18:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=1094s) be upset if it didn't work or the code's
[00:18:16](https://www.youtube.com/watch?v=434cG4g5KLE&t=1096s) important enough that bad business
[00:18:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=1098s) things will happen, you'll get fired,
[00:18:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=1099s) etc. We need to think about these types
[00:18:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=1102s) of code differently. And I would also
[00:18:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=1104s) argue, and this is probably the most
[00:18:25](https://www.youtube.com/watch?v=434cG4g5KLE&t=1105s) important part, nobody spends all of
[00:18:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=1107s) their time in just one of these
[00:18:29](https://www.youtube.com/watch?v=434cG4g5KLE&t=1109s) sections. Okay. Slop coders that just
[00:18:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=1112s) use stuff like lovable spend most of
[00:18:34](https://www.youtube.com/watch?v=434cG4g5KLE&t=1114s) their time here and probably don't go
[00:18:35](https://www.youtube.com/watch?v=434cG4g5KLE&t=1115s) very far down. But people who write a
[00:18:38](https://www.youtube.com/watch?v=434cG4g5KLE&t=1118s) lot of code at the very least hop
[00:18:41](https://www.youtube.com/watch?v=434cG4g5KLE&t=1121s) between one through three. Some touch on
[00:18:43](https://www.youtube.com/watch?v=434cG4g5KLE&t=1123s) this fourth layer, the really scary
[00:18:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=1125s) stuff. But all of us should be writing
[00:18:48](https://www.youtube.com/watch?v=434cG4g5KLE&t=1128s) code in all of these ranges. The thing
[00:18:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=1130s) that changed, if we were to label these
[00:18:51](https://www.youtube.com/watch?v=434cG4g5KLE&t=1131s) as tiers A, B, C, and D, the thing that
[00:18:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=1135s) changed is that tier D code was so
[00:18:59](https://www.youtube.com/watch?v=434cG4g5KLE&t=1139s) expensive that spending any time in the
[00:19:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=1142s) other tiers just didn't seem valuable
[00:19:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=1144s) because it's just as much work to write
[00:19:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=1146s) bad code as it is to write good code if
[00:19:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=1148s) you're writing it by hand and you you
[00:19:10](https://www.youtube.com/watch?v=434cG4g5KLE&t=1150s) how to write good code because it's hard
[00:19:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=1151s) to turn off your brain and all the
[00:19:13](https://www.youtube.com/watch?v=434cG4g5KLE&t=1153s) demons that are like, you have to make
[00:19:15](https://www.youtube.com/watch?v=434cG4g5KLE&t=1155s) sure every line is safe. But,
[00:19:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=1157s) realistically, we should all be doing
[00:19:20](https://www.youtube.com/watch?v=434cG4g5KLE&t=1160s) more in these other ranges. Let's say
[00:19:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=1162s) you're one of these engineers working on
[00:19:23](https://www.youtube.com/watch?v=434cG4g5KLE&t=1163s) pacemakers, and in the average day, the
[00:19:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=1166s) vast majority of the code you wrote was
[00:19:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=1167s) that D tier. It was the death tier.
[00:19:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=1170s) People could die otherwise. I'm not
[00:19:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=1172s) saying write less.
[00:19:33](https://www.youtube.com/watch?v=434cG4g5KLE&t=1173s) I am simply saying you should draw a
[00:19:36](https://www.youtube.com/watch?v=434cG4g5KLE&t=1176s) line between that code and everything
[00:19:39](https://www.youtube.com/watch?v=434cG4g5KLE&t=1179s) else. And you should be writing a whole
[00:19:41](https://www.youtube.com/watch?v=434cG4g5KLE&t=1181s) lot more of the everything else. But,
[00:19:43](https://www.youtube.com/watch?v=434cG4g5KLE&t=1183s) let's take a look at stuff that I do.
[00:19:46](https://www.youtube.com/watch?v=434cG4g5KLE&t=1186s) Let's take a look at how I think of T3
[00:19:48](https://www.youtube.com/watch?v=434cG4g5KLE&t=1188s) code changes, or how I think of Lakebed
[00:19:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=1190s) changes. Some of that code is more
[00:19:52](https://www.youtube.com/watch?v=434cG4g5KLE&t=1192s) important than other parts. Dax touches
[00:19:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=1195s) on this a little bit in his post here.
[00:19:57](https://www.youtube.com/watch?v=434cG4g5KLE&t=1197s) Lately, after a big diff change, instead
[00:19:59](https://www.youtube.com/watch?v=434cG4g5KLE&t=1199s) of reading the diff, I asked the agent
[00:20:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=1200s) for a summary of what it did in every
[00:20:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=1202s) file. Anything weird will stick out
[00:20:03](https://www.youtube.com/watch?v=434cG4g5KLE&t=1203s) immediately, and one to two prompts
[00:20:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=1204s) later, it's completely how he wants it.
[00:20:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=1206s) Files and function signatures he needs
[00:20:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=1208s) to know, but he cares less about the
[00:20:10](https://www.youtube.com/watch?v=434cG4g5KLE&t=1210s) function body. Very much agree here. The
[00:20:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=1212s) way I would think of this is the
[00:20:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=1214s) engineers who wrote mostly tier C and B
[00:20:16](https://www.youtube.com/watch?v=434cG4g5KLE&t=1216s) code should find the right ways to get
[00:20:19](https://www.youtube.com/watch?v=434cG4g5KLE&t=1219s) the pieces that matter out of the parts
[00:20:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=1222s) that are in this tier, so they can
[00:20:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=1224s) ignore more of the parts here. And
[00:20:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=1226s) figuring out
[00:20:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=1228s) where to cut these layers is important.
[00:20:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=1231s) I read all of the function signatures
[00:20:33](https://www.youtube.com/watch?v=434cG4g5KLE&t=1233s) and all of the API definitions in
[00:20:35](https://www.youtube.com/watch?v=434cG4g5KLE&t=1235s) Lakebed, every single one. It is very
[00:20:37](https://www.youtube.com/watch?v=434cG4g5KLE&t=1237s) important to me that the API and SDK are
[00:20:40](https://www.youtube.com/watch?v=434cG4g5KLE&t=1240s) super solid. Because if they're not, it
[00:20:43](https://www.youtube.com/watch?v=434cG4g5KLE&t=1243s) makes maintaining the project over time
[00:20:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=1245s) way harder, it makes future updates way
[00:20:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=1247s) harder, it massively increases the risk
[00:20:49](https://www.youtube.com/watch?v=434cG4g5KLE&t=1249s) of future releases. So, I want to make
[00:20:51](https://www.youtube.com/watch?v=434cG4g5KLE&t=1251s) sure those layers are as solid as
[00:20:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=1255s) possible. And part of how I do that is
[00:20:57](https://www.youtube.com/watch?v=434cG4g5KLE&t=1257s) writing a shitload of slop to test it.
[00:20:59](https://www.youtube.com/watch?v=434cG4g5KLE&t=1259s) One of my favorite things to do when I
[00:21:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=1261s) define a new API or SDK is to put it in
[00:21:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=1264s) a package that works on my machine, and
[00:21:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=1266s) then go spin up 10 agents with much
[00:21:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=1268s) dumber models to build things on top of
[00:21:10](https://www.youtube.com/watch?v=434cG4g5KLE&t=1270s) it. I absolutely love using Grok models,
[00:21:12](https://www.youtube.com/watch?v=434cG4g5KLE&t=1272s) not for actually writing code that
[00:21:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=1274s) matters, but for writing absolute slop,
[00:21:16](https://www.youtube.com/watch?v=434cG4g5KLE&t=1276s) and to see if they, despite being dumb,
[00:21:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=1278s) are still capable of using these APIs.
[00:21:21](https://www.youtube.com/watch?v=434cG4g5KLE&t=1281s) If they are, awesome. I ship it. If they
[00:21:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=1284s) aren't, interesting. I fix it. So, to go
[00:21:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=1288s) back to the pacemaker people, let's say
[00:21:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=1291s) you are mostly writing code here in tier
[00:21:33](https://www.youtube.com/watch?v=434cG4g5KLE&t=1293s) D, but you also have a bunch of tests
[00:21:36](https://www.youtube.com/watch?v=434cG4g5KLE&t=1296s) and harnesses and wrappers and things
[00:21:38](https://www.youtube.com/watch?v=434cG4g5KLE&t=1298s) verifying your work in tier C. I would
[00:21:40](https://www.youtube.com/watch?v=434cG4g5KLE&t=1300s) agree, those things are really
[00:21:41](https://www.youtube.com/watch?v=434cG4g5KLE&t=1301s) important. If you have a test suite that
[00:21:43](https://www.youtube.com/watch?v=434cG4g5KLE&t=1303s) you've slaved over to make sure your
[00:21:45](https://www.youtube.com/watch?v=434cG4g5KLE&t=1305s) super important code continues to work
[00:21:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=1307s) as expected, awesome. I salute you. You
[00:21:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=1310s) should still be reading a lot of that,
[00:21:51](https://www.youtube.com/watch?v=434cG4g5KLE&t=1311s) and you should also be building systems
[00:21:53](https://www.youtube.com/watch?v=434cG4g5KLE&t=1313s) to verify it, too. But maybe, just
[00:21:55](https://www.youtube.com/watch?v=434cG4g5KLE&t=1315s) maybe, you could write more code up
[00:21:57](https://www.youtube.com/watch?v=434cG4g5KLE&t=1317s) here. If you've built all these systems
[00:21:59](https://www.youtube.com/watch?v=434cG4g5KLE&t=1319s) and you have all these tests, and then
[00:22:00](https://www.youtube.com/watch?v=434cG4g5KLE&t=1320s) somebody puts up a PR that you're really
[00:22:03](https://www.youtube.com/watch?v=434cG4g5KLE&t=1323s) not sure about, maybe have an agent do
[00:22:05](https://www.youtube.com/watch?v=434cG4g5KLE&t=1325s) some slop to try out three different
[00:22:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=1327s) theories and test all of them. Maybe
[00:22:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=1329s) have the agent write a new set of tests
[00:22:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=1331s) that don't exist yet for your one-off
[00:22:13](https://www.youtube.com/watch?v=434cG4g5KLE&t=1333s) theory. Maybe you're curious if the code
[00:22:15](https://www.youtube.com/watch?v=434cG4g5KLE&t=1335s) will be faster in Rust than it is in Go,
[00:22:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=1338s) so you have an agent slop port the whole
[00:22:20](https://www.youtube.com/watch?v=434cG4g5KLE&t=1340s) thing over and then run the test suite
[00:22:21](https://www.youtube.com/watch?v=434cG4g5KLE&t=1341s) against it. You know it's not all going
[00:22:23](https://www.youtube.com/watch?v=434cG4g5KLE&t=1343s) to pass. You know it's not all going to
[00:22:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=1344s) merge, but it's going to answer
[00:22:25](https://www.youtube.com/watch?v=434cG4g5KLE&t=1345s) important questions you might have. If
[00:22:27](https://www.youtube.com/watch?v=434cG4g5KLE&t=1347s) you're not finding these opportunities,
[00:22:29](https://www.youtube.com/watch?v=434cG4g5KLE&t=1349s) then you're not curious enough. You're
[00:22:30](https://www.youtube.com/watch?v=434cG4g5KLE&t=1350s) not creative enough. You're not taking
[00:22:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=1351s) advantage of this once-in-a-lifetime
[00:22:33](https://www.youtube.com/watch?v=434cG4g5KLE&t=1353s) opportunity we have here, the ability to
[00:22:35](https://www.youtube.com/watch?v=434cG4g5KLE&t=1355s) generate infinite code. It's crazy how
[00:22:38](https://www.youtube.com/watch?v=434cG4g5KLE&t=1358s) cool it can be. And I understand why you
[00:22:42](https://www.youtube.com/watch?v=434cG4g5KLE&t=1362s) might feel differently. It's cuz the
[00:22:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=1364s) people in this top A tier are the most
[00:22:46](https://www.youtube.com/watch?v=434cG4g5KLE&t=1366s) obnoxious people on Earth. The people
[00:22:49](https://www.youtube.com/watch?v=434cG4g5KLE&t=1369s) who are shipping endless [ __ ] code
[00:22:52](https://www.youtube.com/watch?v=434cG4g5KLE&t=1372s) for services nobody [ __ ] uses. They
[00:22:54](https://www.youtube.com/watch?v=434cG4g5KLE&t=1374s) are the ones who are the loudest on
[00:22:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=1376s) social media, and they are the ones that
[00:22:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=1378s) represent this new slop AI vibe coding
[00:23:01](https://www.youtube.com/watch?v=434cG4g5KLE&t=1381s) movement. I hate them, too.
[00:23:03](https://www.youtube.com/watch?v=434cG4g5KLE&t=1383s) I need you to understand that we are on
[00:23:05](https://www.youtube.com/watch?v=434cG4g5KLE&t=1385s) the same side even if I rage bait on
[00:23:06](https://www.youtube.com/watch?v=434cG4g5KLE&t=1386s) Twitter a little bit. That doesn't mean
[00:23:08](https://www.youtube.com/watch?v=434cG4g5KLE&t=1388s) there isn't value here. There's also the
[00:23:10](https://www.youtube.com/watch?v=434cG4g5KLE&t=1390s) fact that you should probably have AI
[00:23:11](https://www.youtube.com/watch?v=434cG4g5KLE&t=1391s) reading your code too. That's a whole
[00:23:13](https://www.youtube.com/watch?v=434cG4g5KLE&t=1393s) separate rant I don't want to bog this
[00:23:14](https://www.youtube.com/watch?v=434cG4g5KLE&t=1394s) down with but in generally speaking I
[00:23:17](https://www.youtube.com/watch?v=434cG4g5KLE&t=1397s) don't bother my team with code until
[00:23:18](https://www.youtube.com/watch?v=434cG4g5KLE&t=1398s) multiple agents have verified it deeply.
[00:23:21](https://www.youtube.com/watch?v=434cG4g5KLE&t=1401s) Use AI to review your code. It's
[00:23:22](https://www.youtube.com/watch?v=434cG4g5KLE&t=1402s) actually really cool for that. I think
[00:23:24](https://www.youtube.com/watch?v=434cG4g5KLE&t=1404s) this is the diagram that best summarizes
[00:23:26](https://www.youtube.com/watch?v=434cG4g5KLE&t=1406s) my thoughts here on this type of
[00:23:28](https://www.youtube.com/watch?v=434cG4g5KLE&t=1408s) important code. I will be clear, there
[00:23:31](https://www.youtube.com/watch?v=434cG4g5KLE&t=1411s) are lots of other types of code where
[00:23:32](https://www.youtube.com/watch?v=434cG4g5KLE&t=1412s) this level of hand review is not that
[00:23:34](https://www.youtube.com/watch?v=434cG4g5KLE&t=1414s) important and you're probably merging a
[00:23:36](https://www.youtube.com/watch?v=434cG4g5KLE&t=1416s) lot more too. But if your code is so
[00:23:38](https://www.youtube.com/watch?v=434cG4g5KLE&t=1418s) important that you need this pipeline,
[00:23:40](https://www.youtube.com/watch?v=434cG4g5KLE&t=1420s) please be realistic. Most importantly, I
[00:23:43](https://www.youtube.com/watch?v=434cG4g5KLE&t=1423s) want you to be more creative. Find more
[00:23:44](https://www.youtube.com/watch?v=434cG4g5KLE&t=1424s) ways to use code to verify the things
[00:23:47](https://www.youtube.com/watch?v=434cG4g5KLE&t=1427s) that matter. If your code's important,
[00:23:49](https://www.youtube.com/watch?v=434cG4g5KLE&t=1429s) you should write code that isn't to
[00:23:50](https://www.youtube.com/watch?v=434cG4g5KLE&t=1430s) verify the code that is. You'd be amazed
[00:23:52](https://www.youtube.com/watch?v=434cG4g5KLE&t=1432s) what you can come up with when you start
[00:23:54](https://www.youtube.com/watch?v=434cG4g5KLE&t=1434s) treating code as more disposable, as
[00:23:56](https://www.youtube.com/watch?v=434cG4g5KLE&t=1436s) throwaway for one idea, one theory, one
[00:23:58](https://www.youtube.com/watch?v=434cG4g5KLE&t=1438s) question, one thing. Be creative. And
[00:24:02](https://www.youtube.com/watch?v=434cG4g5KLE&t=1442s) you'll make awesome things happen. I've
[00:24:03](https://www.youtube.com/watch?v=434cG4g5KLE&t=1443s) said all I have to on this one and it
[00:24:04](https://www.youtube.com/watch?v=434cG4g5KLE&t=1444s) seems like I pissed everyone off which
[00:24:05](https://www.youtube.com/watch?v=434cG4g5KLE&t=1445s) means mission accomplished. Go be more
[00:24:07](https://www.youtube.com/watch?v=434cG4g5KLE&t=1447s) creative, write more slop, and until
[00:24:09](https://www.youtube.com/watch?v=434cG4g5KLE&t=1449s) next time,
[00:24:10](https://www.youtube.com/watch?v=434cG4g5KLE&t=1450s) peace nerds.
