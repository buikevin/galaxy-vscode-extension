/**
 * @author Bùi Trọng Hiếu
 * @email kevinbui210191@gmail.com
 * @create date 2026-04-02
 * @modify date 2026-04-02
 * @desc NestJS workflow extractor adapter that enriches the generic TypeScript graph with decorator-driven routes and dependency-injection call chains.
 */

import * as ts from 'typescript';
import type { ParsedFile, WorkflowExtractorAdapter, WorkflowGraphContribution } from '../../entities/extractor';
import type { WorkflowEdgeRecord, WorkflowNodeRecord } from '../../entities/graph';
import type {
  WorkflowBackendClassFact,
  WorkflowMethodCallFact,
  WorkflowMethodRouteFact,
} from '../../entities/adapters';
import { buildTypeScriptWorkflowExtractionContext } from '../generic-facts';
import { createFrameworkEdge, createFrameworkEndpointNode, joinFrameworkRoutePath, normalizeFrameworkRoutePath } from '../framework-helpers';

type NestClassFact = WorkflowBackendClassFact;

/**
 * Returns decorators attached to a TypeScript node.
 *
 * @param node TypeScript AST node that may own decorators.
 * @returns Frozen decorator list for the node.
 */
function getDecorators(node: ts.Node): readonly ts.Decorator[] {
  if (!ts.canHaveDecorators(node)) {
    return Object.freeze([]);
  }
  return Object.freeze(ts.getDecorators(node) ?? []);
}

/**
 * Resolves the logical name of a decorator call or identifier.
 *
 * @param decorator Decorator node to inspect.
 * @returns Decorator identifier text when recognized.
 */
function getDecoratorName(decorator: ts.Decorator): string | null {
  const expression = decorator.expression;
  if (ts.isIdentifier(expression)) {
    return expression.text;
  }
  if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression)) {
    return expression.expression.text;
  }
  return null;
}

/**
 * Returns the first string literal argument from a decorator call when present.
 *
 * @param decorator Decorator node to inspect.
 * @returns First string literal argument when the decorator is invoked.
 */
function getDecoratorFirstStringArg(decorator: ts.Decorator): string | null {
  if (!ts.isCallExpression(decorator.expression)) {
    return null;
  }
  const firstArg = decorator.expression.arguments[0];
  if (!firstArg) {
    return null;
  }
  if (ts.isStringLiteralLike(firstArg) || ts.isNoSubstitutionTemplateLiteral(firstArg)) {
    return firstArg.text;
  }
  return null;
}

/**
 * Normalizes a Nest route fragment to an absolute-style route path.
 *
 * @param routePath Raw route fragment from Nest decorators.
 * @returns Normalized absolute-style route path.
 */
/**
 * Collects constructor- or property-injected dependency types from a Nest class.
 *
 * @param classDeclaration Nest class declaration node.
 * @returns Mapping from injected property names to declared dependency types.
 */
function collectInjectedTypes(classDeclaration: ts.ClassDeclaration): ReadonlyMap<string, string> {
  const injectedTypes = new Map<string, string>();

  classDeclaration.members.forEach((member) => {
    if (!ts.isConstructorDeclaration(member)) {
      return;
    }
    member.parameters.forEach((parameter) => {
      if (!ts.isIdentifier(parameter.name) || !parameter.type) {
        return;
      }
      const hasVisibilityModifier = Boolean(
        ts.getModifiers(parameter)?.some((modifier) =>
          modifier.kind === ts.SyntaxKind.PrivateKeyword
          || modifier.kind === ts.SyntaxKind.ProtectedKeyword
          || modifier.kind === ts.SyntaxKind.PublicKeyword
          || modifier.kind === ts.SyntaxKind.ReadonlyKeyword,
        ),
      );
      if (!hasVisibilityModifier) {
        return;
      }
      injectedTypes.set(parameter.name.text, parameter.type.getText());
    });
  });

  classDeclaration.members.forEach((member) => {
    if (!ts.isPropertyDeclaration(member) || !member.type || !ts.isIdentifier(member.name)) {
      return;
    }
    injectedTypes.set(member.name.text, member.type.getText());
  });

  return injectedTypes;
}

/**
 * Extracts `this.<dependency>.method()` style calls from a method body.
 *
 * @param body Method body node to inspect.
 * @returns Sorted injected property names called from the method body.
 */
function collectCalledThisProperties(body: ts.Node): readonly string[] {
  const called = new Set<string>();
  const walk = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isPropertyAccessExpression(node.expression.expression)
      && node.expression.expression.expression.kind === ts.SyntaxKind.ThisKeyword
    ) {
      called.add(node.expression.expression.name.text);
    }
    node.forEachChild(walk);
  };
  walk(body);
  return Object.freeze([...called].sort((a, b) => a.localeCompare(b)));
}

/**
 * Builds a stable workflow node id for a Nest endpoint.
 *
 * @param httpMethod Uppercase HTTP verb.
 * @param routePath Normalized absolute route path.
 * @returns Stable workflow node id for the endpoint.
 */
function buildEndpointNodeId(httpMethod: string, routePath: string): string {
  return `workflow:nest-route:${httpMethod}:${routePath}`;
}

/**
 * Creates an API endpoint node from a Nest route-bearing method fact.
 *
 * @param fact Parsed Nest class fact that owns the route.
 * @param route Route-bearing method fact.
 * @returns Frozen workflow node record for the endpoint.
 */
function createNestEndpointNode(fact: NestClassFact, route: WorkflowMethodRouteFact): WorkflowNodeRecord {
  return createFrameworkEndpointNode({
    id: buildEndpointNodeId(route.httpMethod, route.routePath),
    label: `${route.httpMethod} ${route.routePath}`,
    relativePath: fact.relativePath,
    sourceHash: fact.sourceHash,
    symbolName: route.methodName,
    httpMethod: route.httpMethod,
    routePath: route.routePath,
    description: `NestJS endpoint ${route.httpMethod} ${route.routePath}`,
    descriptionSource: 'nestjs',
    provenanceKind: 'nestjs_route_mapping',
    confidence: 0.9,
  });
}

/**
 * Parses Nest controller/service classes from a parsed TypeScript source file.
 *
 * @param parsedFile Parsed TypeScript workflow file.
 * @returns Frozen list of Nest-specific class facts extracted from the file.
 */
function parseNestClassFact(parsedFile: ParsedFile): readonly NestClassFact[] {
  const facts: NestClassFact[] = [];

  parsedFile.sourceFile.statements.forEach((statement) => {
    if (!ts.isClassDeclaration(statement) || !statement.name) {
      return;
    }
    const decorators = getDecorators(statement);
    const decoratorNames = decorators.map(getDecoratorName).filter((name): name is string => Boolean(name));
    const isController = decoratorNames.includes('Controller');
    const isInjectable = decoratorNames.includes('Injectable');
    const isRepository = /Repository$/.test(statement.name.text) || /repository/.test(parsedFile.relativePath.toLowerCase());

    if (!isController && !isInjectable && !isRepository) {
      return;
    }

    const classNodeId = parsedFile.localSymbolIds.get(statement.name.text);
    if (!classNodeId) {
      return;
    }

    const controllerDecorator = decorators.find((decorator) => getDecoratorName(decorator) === 'Controller');
    const routeBase = controllerDecorator ? normalizeFrameworkRoutePath(getDecoratorFirstStringArg(controllerDecorator)) : undefined;
    const injectedTypes = collectInjectedTypes(statement);

    const methodRoutes: WorkflowMethodRouteFact[] = [];
    const methodCalls: WorkflowMethodCallFact[] = [];

    statement.members.forEach((member) => {
      if (!ts.isMethodDeclaration(member) || !member.body || !ts.isIdentifier(member.name)) {
        return;
      }
      const methodName = member.name.text;
      const memberDecorators = getDecorators(member);
      const routeDecorator = memberDecorators.find((decorator) => {
        const name = getDecoratorName(decorator);
        return name === 'Get' || name === 'Post' || name === 'Put' || name === 'Delete' || name === 'Patch';
      });

      const calledDependencies = collectCalledThisProperties(member.body);
      methodCalls.push({
        methodName,
        calledDependencies,
      });

      if (!routeDecorator) {
        return;
      }

      const routeDecoratorName = getDecoratorName(routeDecorator);
      if (!routeDecoratorName) {
        return;
      }
      methodRoutes.push({
        methodName,
        httpMethod: routeDecoratorName.toUpperCase(),
        routePath: joinFrameworkRoutePath(routeBase, getDecoratorFirstStringArg(routeDecorator) ?? '/'),
        calledDependencies,
      });
    });

    facts.push(Object.freeze({
      relativePath: parsedFile.relativePath,
      sourceHash: parsedFile.sourceHash,
      className: statement.name.text,
      classNodeId,
      classNodeType: isController ? 'controller' : isRepository ? 'repository' : 'backend_service',
      ...(routeBase ? { routeBase } : {}),
      injectedTypes,
      methodRoutes: Object.freeze(methodRoutes),
      methodCalls: Object.freeze(methodCalls),
    }));
  });

  return Object.freeze(facts);
}

/**
 * Extracts NestJS routes and dependency-injection call chains from parsed TypeScript files.
 *
 * @param workspacePath Absolute workspace root path.
 * @returns Workflow graph contribution synthesized from NestJS files.
 */
async function extractNestWorkflowGraph(workspacePath: string): Promise<WorkflowGraphContribution> {
  const context = buildTypeScriptWorkflowExtractionContext(workspacePath);
  const facts = context.parsedFiles.flatMap((parsedFile) => parseNestClassFact(parsedFile));
  if (facts.length === 0) {
    return Object.freeze({
      nodes: Object.freeze([]),
      edges: Object.freeze([]),
    });
  }

  const nodes = new Map<string, WorkflowNodeRecord>();
  const edges = new Map<string, WorkflowEdgeRecord>();
  const classNodeIdByName = new Map<string, string>();

  facts.forEach((fact) => {
    classNodeIdByName.set(fact.className, fact.classNodeId);
  });

  facts.forEach((fact) => {
    fact.methodRoutes.forEach((route) => {
      const endpointNode = createNestEndpointNode(fact, route);
      nodes.set(endpointNode.id, endpointNode);
      const routeEdge = createFrameworkEdge({
        fromNodeId: endpointNode.id,
        toNodeId: fact.classNodeId,
        edgeType: 'routes_to',
        label: route.methodName,
        relativePath: fact.relativePath,
        sourceHash: fact.sourceHash,
        provenanceKind: 'nestjs_controller_binding',
        confidence: 0.9,
      });
      edges.set(routeEdge.id, routeEdge);

      route.calledDependencies.forEach((propertyName) => {
        const targetClassName = fact.injectedTypes.get(propertyName);
        const targetNodeId = targetClassName ? classNodeIdByName.get(targetClassName) : null;
        if (!targetNodeId) {
          return;
        }
        const callEdge = createFrameworkEdge({
          fromNodeId: endpointNode.id,
          toNodeId: targetNodeId,
          edgeType: 'calls',
          label: `${propertyName}.${route.methodName}`,
          relativePath: fact.relativePath,
          sourceHash: fact.sourceHash,
          provenanceKind: 'nestjs_injected_call',
          confidence: 0.8,
        });
        edges.set(callEdge.id, callEdge);
      });
    });

    fact.methodCalls.forEach((methodCall) => {
      methodCall.calledDependencies.forEach((propertyName) => {
        const targetClassName = fact.injectedTypes.get(propertyName);
        const targetNodeId = targetClassName ? classNodeIdByName.get(targetClassName) : null;
        if (!targetNodeId || targetNodeId === fact.classNodeId) {
          return;
        }
        const callEdge = createFrameworkEdge({
          fromNodeId: fact.classNodeId,
          toNodeId: targetNodeId,
          edgeType: 'calls',
          label: `${methodCall.methodName}:${propertyName}`,
          relativePath: fact.relativePath,
          sourceHash: fact.sourceHash,
          provenanceKind: 'nestjs_injected_call',
          confidence: 0.74,
        });
        edges.set(callEdge.id, callEdge);
      });
    });
  });

  return Object.freeze({
    nodes: Object.freeze([...nodes.values()].sort((a, b) => a.id.localeCompare(b.id))),
    edges: Object.freeze([...edges.values()].sort((a, b) => a.id.localeCompare(b.id))),
  });
}

/**
 * Framework adapter for NestJS decorators and injected dependency call chains.
 */
export const nestWorkflowExtractorAdapter: WorkflowExtractorAdapter = Object.freeze({
  id: 'nestjs',
  label: 'NestJS',
  extract: extractNestWorkflowGraph,
});
