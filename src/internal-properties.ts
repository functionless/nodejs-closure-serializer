import inspector from "inspector";
import util from "util";
import { GetPropertiesSession, inspectorSession } from "./inspector-session";

export async function getInternalProperties(
  objectId: inspector.Runtime.RemoteObjectId,
  ownProperties: boolean | undefined
): Promise<inspector.Runtime.InternalPropertyDescriptor[]> {
  const session = <GetPropertiesSession>await inspectorSession;
  const post = util.promisify(session.post);

  // This cast will become unnecessary when we move to TS 3.1.6 or above.  In that version they
  // support typesafe '.call' calls.
  const retType = await post.call(session, "Runtime.getProperties", {
    objectId,
    ownProperties,
  });
  if (retType.exceptionDetails) {
    throw new Error(
      `Error calling "Runtime.getProperties(${objectId}, ${ownProperties})": ` +
        retType.exceptionDetails.text
    );
  }

  return retType.internalProperties ?? [];
}
