I'm building an agentic system to manage the prompts and outputs for my work.

My usual day to day looks like doing some back and forth with the agents, figuring out ideas, then doing deep research and then putting the final results of the research into a document in the directory. As I keep working, the number of documents grow and I need to organize them into directories.

Also, I often find myself doing synthesis over multiple documents. I point my agent at the directory and ask it to combine information across the documents to create new learnings or synthesize a new understanding. This way, what often starts as research in a particular topic ends up in multiple source documents (the research docs) and later synthesized into new learnings.

When I am ready to share my learnings with my team, I ask the agent to turn in into a PDF document or a presentation to share with the team.

Research can start with a simple prompt like "find the top 10 coding agent apps". Then it might expand as I dive deeper like "find me the product managers AND vp of engineering at these companies". Sometimes, I like to take a thread and dive deeper into like. For example, "capture the profile, jobs history, and linkedin posts of John Doe from ABC coding agent". Or perhaps "what direction is ABC coding agent going based on their recent blogs and changelogs from the last 6 months". Once I have these research materials accumulated, I run a synthesis like "is ABC coding agent an ICP for my company and if yes, who should be my target person for outreach", and then perhaps a follow up like "craft the email sequence to send to ideal outreach profile".

Research tasks and synthesis prompts repeat, I often end up copying them around. For example, to continue the same research for another company, I copy the prompt and then repeat the sequence that I just told you about. Repetitions are commons but so is iteration; I would often change something slightly in the prompt before rerunning it.

Often the learnings need to be turned into actions. For example, once my outreach sequence is ready, I use a pre-installed MCP server or CLI to schedule or send the messages. Or sometimes I just craft a document or a spreadsheet and email it over to my team for action. Or sometimes its more complicated like turning the tasks/followups into Linear tickets and tagging the right team members in it. I usually put the information about my company, team members and teams into the directory, right next to the source material, research (organized into nested directories) and learnings/synthesis. With the pre-installed CLIs and MCP servers, the files in the directory and connecting context (AGENTS.md) files, the directory with a Claude Code agent running in it has everything it needs to carry out my tasks.

However, my system of doing work is already showing cracks.

If the AGENTS.md file gets outdated, the agent has trouble finding the right files. When I created nested directories (or rather ask the agent to do so), the nested AGENTS.md also need to be created so that I can start the Claude in any sub-directory if necessary. This is important because the project keeps growing as I add more research material, company information and synthesis into it. I want this project to be the "monorepo" for all context and for all work I am doing with the agent. So keeping it organized, keeping the context files (AGENTS.md) updated and cleaning up leftover files is critical to scaling up this system to a larger context and for long-term use.

Also, it would be great to put the prompts, research files and synthesis as files in the directory. Since I need to repeat or rerun the prompts a lot, I prefer putting them down as file. Then I ask the agent to run the prompt against a specific input file or directory or byitself. This helps me avoid losing the file. Also, having the prompt next to the files helps me (and the agent) figure out how the research files were created (thanks to the source prompt being next to the files). Similarly, I can always track back how the synthesis files were created. If I need to rerun the prompt because the source inputs files or referenced research files have changed, the prompt is already there. I can also create new version of the prompt file by cloning it and iterating on it. However, this does require manual maintaince because files that need to be regenerated when the prompt changes need my attention (mostly I forget). Since files can depend on files and so on, this can form a complicated dependency chain.

I need a better system. I like the idea of having a files-and-directory based system where all my prompts, context and sythensis is. I like the idea of having prompts rerun automatically when files change. A hierarchical directory system to organize my files, context and agent context is also great for scaling up the system. Perhaps we can come up with a structured directory convention to organize everything; then a file watcher can watch for changes and rerun the prompts as needed; also, since the reruns might form a graph of dependencies, the watcher will need to sort this out and make sure everything runs in the right order. Also, Parallel, the web search API/CLI can make for a great candidate for doing web search, research and pulling datasets; I am looking forward to using it to pull research and datasets using prompts. Also, Composio can help provide the tools needed for both research and action like sending email, pulling calender events into a files in a directory, etc. For the agentic system that powers the file watcher (actually, its really an agentic system), we can look into using Cline coding agent using the Cline SDK.


Can you interview me to find the requirements for a better system (I've given you a lot of hints above) and then write the requirements down (along with the technical details) for the next coding agent to implement? You will need to figure out enough technical details (including the specific tools I mentioned above) to build the technical document that the next agent can execute/implement.

Reference:

1. https://docs.cline.bot/sdk/overview
2. https://github.com/cline/sdk-skill
3. https://docs.composio.dev/docs?utm_source=luma
4. https://docs.composio.dev/docs/cli
5. https://docs.composio.dev/docs/composio-connect
6. https://docs.parallel.ai/getting-started/overview
7. https://parallel.ai/agents.md

Note that this project will be submitted to the hackathon: https://luma.com/m8euvq9n?tk=6jS8RP

Submission requires:
- GitHub repository URL (public, open source, with run instructions)
- Project deck URL (3 to 5 slides covering what you built, who it helps, and how it works)
- Demo video URL (maximum 2 minutes, showing it running and identifying anything simulated) (I will record this myself)
