import type { ItemId, UserId } from "../../src/contracts/ids";
import { addClipping } from "../../src/services/clippings";
import { loadTranscript } from "../../src/services/library";
import { addPageNote } from "../../src/services/page-notes";
import { articleHtml, savePage, type TestLibrary } from "./library";

// A believable library: pages about notes and reading, some with authors,
// one with a very long title, clippings with and without notes, and notes on
// whole pages, some of which have no clippings.

type DemoPage = { title: string; host: string; author?: string; lead: string };

export const DEMO_PAGES: readonly DemoPage[] = [
  { title: "What the printing press did to memory", host: "historytoday.com", lead: "When print arrived, scholars feared that nobody would bother to remember anything any more. They were half right." },
  { title: "The joy of small software", host: "robinrendle.com", author: "Robin Rendle", lead: "Small software does one thing, belongs to one person, and can be understood in an afternoon." },
  { title: "Montaigne and the art of the essay", host: "theparisreview.org", lead: "Montaigne did not set out to write essays. He set out to try himself, and the word for trying stuck." },
  { title: "Bret Victor: the humane representation of thought", host: "worrydream.com", author: "Bret Victor", lead: "We are still reading and writing with tools designed for paper, on a medium that could do so much more." },
  { title: "On reading slowly", host: "aeon.co", lead: "Slow reading is not about speed. It is about letting a text take the time it needs to change you." },
  { title: "A brief history of the index", host: "thebrowser.com", author: "Dennis Duncan", lead: "The index was invented not to aid memory but to replace it, and readers of the time complained exactly as we do now." },
  { title: "Shape Up: stop running in circles", host: "basecamp.com", author: "Ryan Singer", lead: "Appetite is the opposite of an estimate. Instead of asking how long something will take, ask how much time it is worth." },
  { title: "Calm technology principles", host: "calmtech.com", author: "Amber Case", lead: "Technology should require the smallest possible amount of attention, and inform without overburdening." },
  { title: "The tyranny of the feed", host: "newyorker.com", author: "Kyle Chayka", lead: "Algorithmic feeds were sold as a way to find what we love. They have become a way to be found by what we don’t." },
  { title: "Luhmann’s Zettelkasten, in his own words", host: "luhmann.surge.sh", author: "Niklas Luhmann", lead: "The card index is not a memory but a partner in communication; it answers back with things you did not know you had put there." },
  { title: "Why I still keep a paper diary", host: "theguardian.com", author: "Oliver Burkeman", lead: "I have kept a paper diary since I was fourteen. Not for posterity; for the pleasure of the pen, and of not being watched." },
  { title: "Against the stream", host: "every.to", lead: "The feed promises everything, now. What it delivers is the feeling of having read, without the reading." },
  { title: "Paper is a very good technology", host: "craigmod.com", author: "Craig Mod", lead: "Paper forgets nothing and asks for nothing. It has no notifications, and it never needs an update." },
  { title: "An index card is a little machine for thinking", host: "robinsloan.com", author: "Robin Sloan", lead: "An index card is small enough to hold one idea, and stiff enough to stand up in a box. Both of those turn out to matter." },
  { title: "The web we lost", host: "anildash.com", author: "Anil Dash", lead: "In the early days of the social web, there was a broad expectation that you owned your own words, and could take them anywhere." },
  { title: "How to take smart notes, revisited", host: "fortelabs.com", author: "Tiago Forte", lead: "Luhmann’s method is often summarised as a filing system. It was really a way of having a conversation with your past self." },
  { title: "Notes on the commonplace book tradition", host: "publicdomainreview.org", lead: "For three centuries, educated readers kept books of extracts, copied out under headings so a sentence met once could be found again." },
  { title: "The garden and the stream: a technopastoral", host: "hapgood.us", author: "Mike Caulfield", lead: "I find it hard to communicate with a lot of technologists anymore. It’s like trying to explain literature to someone who has never read a book." },
  { title: "The unreasonable effectiveness of writing things down: notes from twenty years of keeping index cards, commonplace books, and personal wikis", host: "kottke.org", author: "Jason Kottke", lead: "For twenty years I have written things down: on index cards, in notebooks, in a wiki that nobody else reads. Here is what that habit has given back." },
];

const FILLER = [
  "Readers copied passages out under headings, so that a sentence met once could be found again and set beside others it had never met.",
  "The habit asks for very little: a place to put things, and the patience to come back to them later, when they mean something new.",
  "Most of what we read is gone within a week. What stays is what we wrote down, and what we wrote down is what we chose.",
  "A note is a letter to a future reader who happens to share your name, and who will have forgotten nearly everything you know now.",
  "The margin is where the reader talks back, and a book with no marks in it has only been half read.",
  "Tools that promise to remember for us tend to remember everything and surface nothing, which is its own kind of forgetting.",
];

function paragraphsFor(index: number, lead: string): string[] {
  const count = 3 + (index % 4);
  return [lead, ...Array.from({ length: count }, (_, offset) => FILLER[(index + offset) % FILLER.length]!)];
}

async function clip(library: TestLibrary, owner: UserId, itemId: ItemId, quote: string, note: string | null): Promise<void> {
  const deps = { db: library.db, itemsRoot: library.itemsRoot };
  const { transcript } = await loadTranscript(deps, owner, itemId);
  const start = transcript.indexOf(quote);
  if (start === -1) throw new Error(`demo quote missing: ${quote}`);
  await addClipping(deps, owner, itemId, { start, end: start + quote.length }, note, library.clock.now);
}

// Saves `rounds` copies of the demo pages, oldest first, and clips and notes a
// few.
// Later copies are titled as further parts, so a card or a search result can
// be told from its twins.
// Returns the item IDs newest first, as the library lists them.
export async function seedDemo(library: TestLibrary, owner: UserId, rounds = 1): Promise<ItemId[]> {
  const ids: ItemId[] = [];
  for (let round = 0; round < rounds; round += 1) {
    for (const [index, page] of DEMO_PAGES.entries()) {
      const suffix = round === 0 ? "" : `-${round}`;
      const itemId = await savePage(
        library,
        owner,
        `https://www.${page.host}/${page.title.toLowerCase().replaceAll(/[^a-z]+/g, "-")}${suffix}`,
        articleHtml({ title: round === 0 ? page.title : `${page.title}, part ${round + 1}`, author: page.author, paragraphs: paragraphsFor(index + round, page.lead) }),
      );
      ids.push(itemId);
      if (round > 0) continue;
      if (index % 3 === 0) await clip(library, owner, itemId, page.lead.split(/(?<=[.;:])\s/)[0]!, index % 2 === 0 ? "This is why the habit matters." : null);
      if (index % 4 === 1) await clip(library, owner, itemId, FILLER[(index + 1) % FILLER.length]!, null);
      const deps = { db: library.db, itemsRoot: library.itemsRoot };
      if (index % 4 === 1) addPageNote(deps, owner, itemId, "Come back to this when writing about attention.", library.clock.now);
      if (index % 7 === 3) addPageNote(deps, owner, itemId, "Nothing here to clip, but the argument stays with me: memory is a practice, not a store.", library.clock.now);
    }
  }
  return ids.toReversed();
}
