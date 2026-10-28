/**
 * The token's send disclaimer, appended on its own line to a message the model
 * wrote.
 *
 * Applied here, in the send handlers, rather than asked of the model: a model
 * told to sign its messages can forget, reword or drop the line, and the people
 * receiving them are exactly who it is for. The tool's response names what was
 * appended, so the model can tell the user and does not add a sign-off of its
 * own.
 */
export function withSendDisclaimer(text: string, disclaimer: string | undefined): string {
  return disclaimer ? `${text}\n\n${disclaimer}` : text
}
