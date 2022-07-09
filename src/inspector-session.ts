import inspector from "inspector";
import util from "util";
import vm from "vm";

// We want to call util.promisify on inspector.Session.post. However, due to all the overloads of
// that method, promisify gets confused.  To prevent this, we cast our session object down to an
// interface containing only the single overload we care about.
export interface PostSession<TMethod, TParams, TReturn> {
  post(
    method: TMethod,
    params?: TParams,
    callback?: (err: Error | null, params: TReturn) => void
  ): void;
}

export interface EvaluationSession
  extends PostSession<
    "Runtime.evaluate",
    inspector.Runtime.EvaluateParameterType,
    inspector.Runtime.EvaluateReturnType
  > {}

export interface GetPropertiesSession
  extends PostSession<
    "Runtime.getProperties",
    inspector.Runtime.GetPropertiesParameterType,
    inspector.Runtime.GetPropertiesReturnType
  > {}
export interface CallFunctionSession
  extends PostSession<
    "Runtime.callFunctionOn",
    inspector.Runtime.CallFunctionOnParameterType,
    inspector.Runtime.CallFunctionOnReturnType
  > {}
export interface ContextSession {
  post(
    method: "Runtime.disable" | "Runtime.enable",
    callback?: (err: Error | null) => void
  ): void;
  once(
    event: "Runtime.executionContextCreated",
    listener: (
      message: inspector.InspectorNotification<inspector.Runtime.ExecutionContextCreatedEventDataType>
    ) => void
  ): void;
}

export interface InflightContext {
  contextId: number;
  functions: Record<string, any>;
  currentFunctionId: number;
  calls: Record<string, any>;
  currentCallId: number;
}
const scriptIdToUrlMap = new Map<string, string>();

export const inspectorSession = createInspectorSession();

// Isolated singleton context accessible from the inspector.
// Used instead of `global` object to support executions with multiple V8 vm contexts as, e.g., done by Jest.
export const inflightContext = createInflightContext();

async function createInspectorSession() {
  const inspectorSession = new inspector.Session();

  inspectorSession.connect();

  // Enable debugging support so we can hear about the Debugger.scriptParsed event. We need that
  // event to know how to map from scriptId's to file-urls.
  await new Promise<inspector.Debugger.EnableReturnType>((resolve, reject) => {
    inspectorSession.post("Debugger.enable", (err, res) =>
      err ? reject(err) : resolve(res)
    );
  });

  inspectorSession.addListener("Debugger.scriptParsed", (event) => {
    const { scriptId, url } = event.params;
    scriptIdToUrlMap.set(scriptId, url);
  });

  return inspectorSession;
}

async function createInflightContext(): Promise<InflightContext> {
  const context: InflightContext = {
    contextId: 0,
    functions: {},
    currentFunctionId: 0,
    calls: {},
    currentCallId: 0,
  };
  const session = <ContextSession>await inspectorSession;
  const post = util.promisify(session.post);

  // Create own context with known context id and functionsContext as `global`
  await post.call(session, "Runtime.enable");
  const contextIdAsync = new Promise<number>((resolve) => {
    session.once("Runtime.executionContextCreated", (event) => {
      resolve(event.params.context.id);
    });
  });
  vm.createContext(context);
  context.contextId = await contextIdAsync;
  await post.call(session, "Runtime.disable");

  return context;
}
