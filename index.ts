import { Console, Effect } from "effect";

const program = Console.log("Test")

Effect.runSync(program)