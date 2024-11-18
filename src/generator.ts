import {type Model,createPrismaSchemaBuilder} from '@mrleebo/prisma-ast'
import * as gh from '@prisma/generator-helper'
import {goTrySync} from 'go-go-try'
import assert from 'node:assert'
import {createHash} from 'node:crypto'
import {copyFileSync,mkdirSync,readFileSync} from 'node:fs'
import fs from 'node:fs/promises'
import path from 'node:path'

const run = <T>(fn: () => T) => fn()
const regex = /^_/

const toSnakeCase = (str: string) => {
	return str
		.replace(/\.?([A-Z]+)/g, (x, y) => `_${y.toLowerCase()}`)
		.replace(regex, '')
		.replace(/\s+/g, '_')
		.toLowerCase()
}

const { generatorHandler } = gh.default

const mysqlMappings = {
	String: 'VARCHAR(191)',
	Boolean: 'BOOLEAN',
	Int: 'INT',
	BigInt: 'BIGINT',
	Float: 'DOUBLE',
	Decimal: 'DECIMAL(65,30)',
	DateTime: 'DATETIME(3)',
	Json: 'JSON',
} as const
const generateModelComment = (
	schemaName: string,
	model: gh.DMMF.Model,
	schemaModel: Model,
	builder: ReturnType<typeof createPrismaSchemaBuilder>,
) => {
	const modelName = model.dbName ?? model.name
	const commentStatements: string[] = []
	const tableComment = model.documentation

	if (tableComment) {
		const tableCommentStr = `
SET @preparedStatement = (SELECT IF(EXISTS
  (
    SELECT table_name 
            FROM INFORMATION_SCHEMA.TABLES
           WHERE table_schema = '${schemaName}'
             AND table_name LIKE '${modelName}'
  ),
  CONCAT("ALTER TABLE ${modelName} COMMENT ", '"${tableComment.trim()}"'),
  "SELECT 1"
));
PREPARE alterIfExists FROM @preparedStatement;
EXECUTE alterIfExists;
DEALLOCATE PREPARE alterIfExists;
`
		commentStatements.push(tableCommentStr)
	}

	for (const field of model.fields) {
		if (!field.documentation) {
			continue
		}
		const escapedComment = field.documentation?.replace(/'/g, "''") ?? ''
		const fieldName = toSnakeCase(field.name)
		const schemaField = builder.findByType('field', {
			name: field.name,
			within: schemaModel.properties,
		})
		assert(schemaField, `Field ${field.name} not found in schema`)
		const dbAttribute = schemaField.attributes?.find(
			(attr) => attr.group === 'db',
		)
		const columnType = run(() => {
			if (dbAttribute === undefined)
				return mysqlMappings[field.type as keyof typeof mysqlMappings]
			const attrLength = dbAttribute.args?.find(
				(arg) => arg.type === 'attributeArgument',
			)?.value
			return `${dbAttribute.name.toUpperCase()}${attrLength ? `(${attrLength})` : ''}`
		})
		if (columnType) {
			const commentTemplate = `
SET @preparedStatement = (SELECT IF(EXISTS
  (
    SELECT table_name 
            FROM INFORMATION_SCHEMA.TABLES
           WHERE table_schema = '${schemaName}'
             AND table_name LIKE '${modelName}'
			 AND column_name LIKE '${fieldName}'
  ),
  CONCAT("ALTER TABLE ${modelName} MODIFY COLUMN ${fieldName} ${columnType} ${field.isRequired ? 'NOT NULL' : ''} COMMENT ", '"${escapedComment.trim()}"'),
  "SELECT 1"
));
PREPARE alterIfExists FROM @preparedStatement;
EXECUTE alterIfExists;
DEALLOCATE PREPARE alterIfExists;
`
			commentStatements.push(commentTemplate)
		}
	}

	return commentStatements.length > 0
		? [`-- Model ${modelName} comments`, '', ...commentStatements, '']
		: null
}

const fileHash = (file: string, allowEmpty = false) => {
	const [_, fileContent] = goTrySync(() => readFileSync(file, 'utf-8'))
	if (fileContent === undefined) {
		if (allowEmpty) return ''
		throw new Error(`File ${file} not found`)
	}
	return createHash('sha256').update(fileContent).digest('hex')
}

const lockChanged = (lockFile: string, tmpLockFile: string) =>
	fileHash(lockFile, true) !== fileHash(tmpLockFile)

export async function generate({
	dmmf,
	schemaPath,
	datamodel,
}: gh.GeneratorOptions) {
	const outputDir = path.dirname(schemaPath)
	const schemaName = outputDir.split('/').at(-1)
	if (!schemaName) return
	mkdirSync(outputDir, { recursive: true })
	const builder = createPrismaSchemaBuilder(datamodel)
	const allStatements: string[][] = []
	for (const model of dmmf.datamodel.models) {
		const schemaModel = builder.findByType('model', { name: model.name })
		assert(schemaModel, `Model ${model.name} not found in schema`)
		const modelComment = generateModelComment(schemaName, model, schemaModel, builder)
		if (modelComment) allStatements.push(modelComment)
	}

	const tmpLock = await fs.open(`${outputDir}/.comments-lock.tmp`, 'w+')
	await tmpLock.write('-- generator-version: 1.0\n\n')
	const allStatementsString = allStatements
		.map((statements) => statements.join('\n'))
		.join('\n\n')
	await tmpLock.write(allStatementsString)
	await tmpLock.close()
	const isChanged = lockChanged(
		`${outputDir}/.comments-lock`,
		`${outputDir}/.comments-lock.tmp`,
	)

	if (isChanged) {
		copyFileSync(
			`${outputDir}/.comments-lock.tmp`,
			`${outputDir}/.comments-lock`,
		)
		const date = new Date()
		date.setMilliseconds(0)
		const dateStr = String(Number(date
			.toISOString()
			.replace(/[:\-TZ]/g, '')
			.replace('.000', '')) + 1)
		const migrationDir = `${outputDir}/migrations/${dateStr}_update_comments`
		console.log(
			`Lock file changed, creating a new migration at ${migrationDir}...`,
		)
		mkdirSync(migrationDir, { recursive: true })
		copyFileSync(`${outputDir}/.comments-lock`, `${migrationDir}/migration.sql`)
	} else {
		console.log(
			'No changes detected, skipping creating a fresh comment migration...',
		)
	}
	await fs.unlink(`${outputDir}/.comments-lock.tmp`)
	console.log('Comment generation completed')
}

generatorHandler({
	onManifest() {
		return {
      version: '1.0.0',
			defaultOutput: 'comments',
			prettyName: 'Prisma MySQL Comments Generator',
		}
	},
	onGenerate: generate,
})
