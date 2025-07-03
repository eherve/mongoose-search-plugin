/** @format */

import * as chai from 'chai';
import * as chaiAsPromised from 'chai-as-promised';
import * as lodash from 'lodash';
import mongoose from 'mongoose';
import { searchPlugin } from './plugin';
import { searchFrText } from './update-tools';

const mongoUrl = `mongodb://localhost:27017/test-datatable`;
mongoose.set('strictQuery', false);

const ProduitSchema = new mongoose.Schema(
  {
    reference: { type: String },
    description: { type: String, search: true },
  },
  { _id: false }
); // _id désactivé pour éviter des _id imbriqués inutiles

const ModelSchema = new mongoose.Schema({
  code: { type: String, search: true },
  reference: { type: String, search: { weight: 10 } },
  description: { type: String, search: true },
  email: { type: String, search: { unchanged: true } },
  details: {
    type: {
      type: String,
    },
    status: {
      type: String,
    },
    commentaire: {
      type: String,
      search: true,
    },
  },
  produit: { type: ProduitSchema },
  produits: { type: [ProduitSchema] },
});

mongoose.plugin(searchPlugin, {test: 'wtf'});

const model: mongoose.Model<any> = mongoose.model('Parent', ModelSchema) as any;

const fields = [
  {
    path: 'code',
    textPath: '__code',
    name: 'code',
    unchanged: false,
    weight: 1,
  },
  {
    path: 'reference',
    textPath: '__reference',
    name: 'reference',
    unchanged: false,
    weight: 1,
  },
  {
    path: 'description',
    textPath: '__description',
    name: 'description',
    unchanged: false,
    weight: 1,
  },
  {
    path: 'email',
    textPath: '__email',
    name: 'email',
    unchanged: true,
    weight: 1,
  },
  {
    path: 'details.commentaire',
    textPath: 'details.__commentaire',
    name: 'details.commentaire',
    unchanged: false,
    weight: 1,
  },
  {
    path: 'produit.description',
    textPath: 'produit.__description',
    name: 'description',
    unchanged: false,
    weight: 1,
  },
  {
    path: 'produits.description',
    textPath: 'produits.__description',
    name: 'description',
    unchanged: false,
    weight: 1,
    arrays: ['produits'],
  },
];

chai.use(chaiAsPromised);
const expect = chai.expect;

let select: string = '';
fields.forEach(field => {
  select += `+${field.textPath} `;
});

describe('Search Lib', () => {
  before(done => {
    mongoose.connect(mongoUrl);
    mongoose.connection.on('error', done);
    mongoose.connection.on('open', done);
  });

  beforeEach(reset);

  it('initial value on insertMany/create', async () => {
    const data = await model.find({}).select(select);
    data.forEach(d => checkFields(d));
  });

  it('find one with $text', async () => {
    let data = await model.find({ $text: { $search: 'PlAnifiee' } });
    expect(data).to.have.lengthOf(1);
    expect(data[0]).to.have.property('code', 'B02');
    data = await model.find({ $text: { $search: 'PlAni' } });
    expect(data).to.have.lengthOf(1);
    expect(data[0]).to.have.property('code', 'B02');
    data = await model.find({ $text: { $search: '"Composant utilisé pour établir"' } });
    expect(data).to.have.lengthOf(1);
    expect(data[0]).to.have.property('code', 'B02');
  });

  it('find weight with $text', async () => {
    let data = await model
      .find({ $text: { $search: 'REF_ALPHA' } }, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } });
    expect(data).to.have.lengthOf(2);
    expect(data[0]).to.have.property('reference', 'REF_ALPHA');
    expect(data[1]).to.have.property('reference', 'REF-BETA');
    data = await model
      .find({ $text: { $search: 'Composant utilisé établir' } }, { score: { $meta: 'textScore' } })
      .sort({ score: { $meta: 'textScore' } });
    expect(data).to.have.lengthOf(2);
    expect(data[0]).to.have.property('code', 'B02');
    expect(data[1]).to.have.property('code', 'A01');
  });

  it('update one $set', async () => {
    const filter = { code: 'A01' };
    await model.updateOne(filter, { $set: { reference: 'TEST-CHANGE-REF3' } });
    const data = await model.findOne(filter).select(select);
    checkFields(data);
  });

  it('update one $set in array', async () => {
    const filter = { code: 'A01', 'produits.reference': 'P-1001' };
    await model.updateOne(filter, { $set: { 'produits.$.description': 'product 1001 updated' } });
    const data = await model.findOne(filter).select(select);
    checkFields(data);
  });

  it('update many $set', async () => {
    const filter = {};
    await model.updateMany(filter, { $set: { description: `New description` } });
    const data = await model.find(filter).select(select);
    data.forEach(d => checkFields(d));
  });

  it('update many $set', async () => {
    const filter = {};
    await model.updateMany(filter, { $set: { 'produits.$[].description': `New description` } });
    const data = await model.find(filter).select(select);
    data.forEach(d => checkFields(d));
  });

  it('update one $set', async () => {
    const filter = { code: 'A01' };
    await model.updateOne(filter, { $set: { reference: 'TEST-CHANGE-REF3' } });
    const data = await model.findOne(filter).select(select);
    checkFields(data);
  });

  it('bulk update one', async () => {
    const filter = { code: 'A01' };
    await model.bulkWrite([
      {
        updateOne: {
          filter,
          update: { $set: { reference: 'TEST-CHANGE-REF-bulk' } },
        },
      },
    ]);
    const data = await model.findOne(filter).select(select);
    checkFields(data);
  });

  it('bulk update many', async () => {
    const filter = {};
    await model.bulkWrite([
      {
        updateMany: {
          filter,
          update: { $set: { reference: 'TEST-CHANGE-REF-bulk' } },
        },
      },
    ]);
    const data = await model.findOne(filter).select(select);
    checkFields(data);
  });

  it('aggregation merge with whenMatched as merge', async () => {
    const filter = { code: 'A01' };
    await model.aggregate([
      { $match: filter },
      { $project: { reference: 'TEST-CHANGE-REF-AGGRéGation' } },
      {
        $merge: {
          into: model.collection.collectionName,
          whenNotMatched: 'discard',
          whenMatched: 'merge',
        },
      },
    ]);
    const data = await model.findOne(filter).select(select);
    checkFields(data);
  });

  it('aggregation merge with whenMatched as replace', async () => {
    const filter = { code: 'A01' };
    await model.aggregate([
      { $match: filter },
      { $addFields: { reference: 'TEST-CHANGE-REF-AGGRéGation' } },
      {
        $merge: {
          into: model.collection.collectionName,
          whenNotMatched: 'discard',
          whenMatched: 'replace',
        },
      },
    ]);
    const data = await model.findOne(filter).select(select);
    checkFields(data);
  });

  after(() => {
    mongoose.connection.close();
  });
});

function checkFields(obj: any) {
  fields.forEach(field => {
    if (field.unchanged) return;
    check(obj, field.textPath);
  });
}

function check(obj: any, path: string) {
  if (lodash.isNil(obj)) return;
  const chunks = path.split('.');
  const head = chunks[0];
  if (chunks.length > 1) {
    expect(obj).to.have.property(head);
  } else {
    expect(obj).to.have.property(head, searchFrText(obj[head.slice(2)]));
  }
  if (head !== path) {
    const sobj = obj[head];
    if (Array.isArray(sobj)) {
      sobj.forEach(o => check(o, chunks.slice(1).join('.')));
    } else check(sobj, chunks.slice(1).join('.'));
  }
}

async function reset(): Promise<void> {
  await model.deleteMany();
  await seed();
}

async function seed(): Promise<void> {
  await model.insertMany([
    {
      code: 'A01',
      reference: 'REF_ALPHA',
      description: 'Objet fondamental utilisé pour initialiser les procédures de traitement automatisé.',
      email: 'utilisateur.alpha@example.com',
      details: {
        type: 'Initialisation',
        status: 'Actif',
        commentaire: 'Aucune anomalie détectée lors de l’initialisation.',
      },
      produit: { reference: 'P-1000', description: 'test produit' },
      produits: [
        { reference: 'P-1001', description: 'Clé USB 32 Go – compacte et rapide' },
        { reference: 'P-1002', description: 'Adaptateur HDMI vers VGA – avec audio intégré' },
      ],
    },
    {
      code: 'B02',
      reference: 'REF-BETA',
      description: 'Composant utilisé pour établir des connexions avec des interfaces externes.',
      email: 'beta.contact@example.org',
      details: {
        type: 'Synchronisation',
        status: 'En attente',
        commentaire: 'Synchronisation planifiée pour la semaine prochaine. REF_ALPHA',
      },
      produits: [
        { reference: 'P-2001', description: 'Routeur 4G LTE – antennes amovibles' },
        { reference: 'P-2002', description: 'Module d’extension réseau sécurisé' },
      ],
    },
  ]);

  await model.create([
    {
      code: 'C03',
      reference: 'REF-GAMMA',
      description: 'Module complémentaire pour supervision avancée.',
      email: 'gamma.support@example.net',
      details: {
        type: 'Audit',
        status: 'Inactif',
        commentaire: 'Désactivé "temporairement" pour maintenance.',
      },
      produits: [
        { reference: 'P-3001', description: 'Sonde de température IP65 – usage industriel.' },
        { reference: 'P-3002', description: "L'interface de supervision SNMP v3" },
      ],
    },
  ]);

  // if (!printed) {
  //   printed = true;
  //   console.log(inspect(await model.find({}), false, null, true));
  // }
}

// let printed = false;
