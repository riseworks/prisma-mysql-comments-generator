# prisma-mysql-comments-generator

Generate database comments from Prisma schema to a MySQL database.

It is based on the following code idea. Thank you @Jyrno42 .

- https://github.com/prisma/prisma/issues/8703#issuecomment-1614360386

## Features

- Create a migration SQL for the `ALTER TABLE table_name MODIFY COLUMN column_name column_type COMMENT "comment";` statement based on the information in the `schema.prisma` file.
    - Comments written with triple slashes (`///`) are eligible.
- Supports only column comments for now (PRs are welcome).

## Usage

Install this package.

```
npm install --save-dev prisma-mysql-comments-generator
```

Add the generator to the `schema.prisma`

```prisma
generator comments {
  provider = "prisma-mysql-comments-generator"
}
```

Run `npx prisma generate` to trigger the generator.
A SQL file with `ALTER TABLE table_name MODIFY COLUMN column_name column_type COMMENT "comment";` is generated in the migrations folder.

## License

MIT

## Author

[thelinuxlich](https://github.com/thelinuxlich)
