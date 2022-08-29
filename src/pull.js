'use strict'

const fs = require('fs')
const path = require('path')
// TODO: cloneDeepだけならJSON.stringify()で十分なのでlodashやめる
const _ = require('lodash')
const mkdirp = require('mkdirp')
const { prettyln, trim, createDirPath, createFilePath } = require('./util')
const { fetchKintoneInfo, downloadFile } = require('./client')
const { convertAppIdToName } = require('./converter')

const prettier = require('prettier')
// .prettierrcがあればそれに沿ってフォーマット
const prettierOptions = prettier.resolveConfig.sync(process.cwd()) || {}
// parserを指定しないと警告が出るのでその対策
prettierOptions.parser = prettierOptions.parser || 'babel'

const compare = (i, j) => {
  if (i < j) {
    return -1
  } else if (i > j) {
    return 1
  }
  return 0
}

const cloneSort = (ktn, kintoneInfoObj) => {
  switch (ktn.command) {
    case 'app/form/fields.json': {
      const keys = Object.keys(kintoneInfoObj.properties)
      keys.sort()
      const properties = keys.reduce((obj, key) => {
        const property = _.cloneDeep(kintoneInfoObj.properties[key])
        if (property.lookup) {
          property.lookup.fieldMappings.sort((i, j) => compare(i.field, j.field))
        }
        if (property.type === 'DROP_DOWN') {
          const options = Object.entries(_.cloneDeep(property.options))
          options.sort(([, i], [, j]) => compare(Number(i.index), Number(j.index)))
          property.options = Object.fromEntries(options)
        }
        obj[key] = property
        return obj
      }, {})
      return { properties }
    }
    case 'app/views.json': {
      const viewEntries = Object.entries(_.cloneDeep(kintoneInfoObj.views))
      const indexes = Object.values(kintoneInfoObj.views).map((v) => v.index)
      indexes.sort((i, j) => compare(Number(i), Number(j)))
      const views = indexes.reduce((obj, index) => {
        const [key, value] = viewEntries.find(([, value]) => value.index === index)
        obj[key] = value
        return obj
      }, {})
      return { views }
    }
    case 'field/acl.json': {
      const rights = _.cloneDeep(kintoneInfoObj.rights)
      rights.sort((i, j) => compare(i.code, j.code))
      return { rights }
    }
  }
  return kintoneInfoObj
}

const convertKintoneInfo = (kintoneInfoObj, ktn, opts) => {
  let kintoneRevision
  if (kintoneInfoObj.revision) {
    kintoneRevision = prettyln({ revision: kintoneInfoObj.revision })
    delete kintoneInfoObj.revision
  }
  const kintoneInfo = prettyln(cloneSort(ktn, kintoneInfoObj))

  let kintoneInfoAlt
  if (opts.alt) {
    const isConverted = convertAppIdToName(ktn, kintoneInfoObj)
    kintoneInfoAlt = isConverted ? prettyln(cloneSort(ktn, kintoneInfoObj)) : undefined
  }

  return [kintoneInfo, kintoneRevision, kintoneInfoAlt]
}

const saveKintoneInfo = async (filePath, kintoneInfo) => {
  const extension = path.extname(filePath)
  if (extension === '.js') {
    kintoneInfo = prettier.format(
      trim(`
// Generated by ginue
module.exports = ${kintoneInfo}
`),
      prettierOptions
    )
  }
  fs.writeFileSync(filePath, kintoneInfo)
}

const downloadCustomizeFiles = async (kintoneInfo, ktn, opts) => {
  const customizeInfo = JSON.parse(kintoneInfo)
  const fileInfos = ['desktop', 'mobile'].flatMap((target) =>
    [customizeInfo[target].js, customizeInfo[target].css].flatMap((infos) =>
      infos.filter((info) => info.type === 'FILE').map((info) => ({ ...info.file, target }))
    )
  )
  const dirPath = `${createDirPath(ktn, opts)}/customize`
  for (const jsFileInfo of fileInfos) {
    const { fileKey, name, target } = jsFileInfo
    const jsFile = await downloadFile(ktn, fileKey)
    const jsFilePath = `${dirPath}/${target}/${name}`
    mkdirp.sync(path.dirname(jsFilePath))
    fs.writeFileSync(jsFilePath, jsFile)
    console.info(jsFilePath)
  }
}

exports.ginuePull = async (ktn, opts) => {
  if (!ktn.methods.includes('GET')) {
    return
  }
  const kintoneInfoObj = await fetchKintoneInfo(ktn, opts)
  const [kintoneInfo, kintoneRevision, kintoneInfoAlt] = convertKintoneInfo(kintoneInfoObj, ktn, opts)
  const filePath = createFilePath(ktn, opts)
  console.info(filePath)
  saveKintoneInfo(filePath, kintoneInfo)
  if (kintoneRevision) {
    // TODO: 無駄に何回も上書保存するので、フラグを持たせて1回だけにしたい
    const revisionFilePath = createFilePath(ktn, opts, 'revision.json')
    saveKintoneInfo(revisionFilePath, kintoneRevision)
  }
  if (kintoneInfoAlt) {
    const altFilePath = filePath.replace('.js', '-alt.js') // (.json|.js) どっちにも対応するhack。。。
    console.info(altFilePath)
    saveKintoneInfo(altFilePath, kintoneInfoAlt)
  }
  if (ktn.command === 'app/customize.json' && opts.downloadJs) {
    await downloadCustomizeFiles(kintoneInfo, ktn, opts)
  }
}
