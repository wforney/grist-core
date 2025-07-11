import {FormLayoutNode, selectPlaceholder} from 'app/client/components/FormRenderer';
import {buildEditor} from 'app/client/components/Forms/Editor';
import {FormView} from 'app/client/components/Forms/FormView';
import {BoxModel, ignoreClick} from 'app/client/components/Forms/Model';
import * as css from 'app/client/components/Forms/styles';
import {stopEvent} from 'app/client/lib/domUtils';
import {makeT} from 'app/client/lib/localization';
import {DocModel, refRecord} from 'app/client/models/DocModel';
import TableModel from 'app/client/models/TableModel';
import {
  FormNumberFormat,
  FormOptionsAlignment,
  FormOptionsSortOrder,
  FormSelectFormat,
  FormTextFormat,
  FormToggleFormat,
} from 'app/client/ui/FormAPI';
import {autoGrow} from 'app/client/ui/forms';
import {cssCheckboxSquare, cssLabel, squareCheckbox} from 'app/client/ui2018/checkbox';
import {colors} from 'app/client/ui2018/cssVars';
import {cssRadioInput} from 'app/client/ui2018/radio';
import {isBlankValue} from 'app/common/gristTypes';
import {Constructor, not} from 'app/common/gutil';
import {
  BindableValue,
  Computed,
  Disposable,
  dom,
  DomContents,
  DomElementArg,
  Holder,
  IDisposableOwner,
  IDomArgs,
  makeTestId,
  MultiHolder,
  observable,
  Observable,
  toKo,
} from 'grainjs';
import * as ko from 'knockout';

const testId = makeTestId('test-forms-');

const t = makeT('Field');

/**
 * Container class for all fields.
 */
export class FieldModel extends BoxModel {

  /**
   * Edit mode, (only one element can be in edit mode in the form editor).
   */
  public edit = Observable.create(this, false);
  public fieldRef = this.autoDispose(ko.pureComputed(() => toKo(ko, this.leaf)()));
  public field = refRecord(this.view.gristDoc.docModel.viewFields, this.fieldRef);
  public colId = Computed.create(this, (use) => use(use(this.field).colId));
  public column = Computed.create(this, (use) => use(use(this.field).column));
  public required: Computed<boolean>;
  public question = Computed.create(this, (use) => {
    const field = use(this.field);
    if (field.isDisposed() || use(field.id) === 0) { return ''; }
    return use(field.question) || use(field.origLabel);
  });

  public description = Computed.create(this, (use) => {
    const field = use(this.field);
    return use(field.description);
  });

  /**
   * Column type of the field.
   */
  public colType = Computed.create(this, (use) => {
    const field = use(this.field);
    return use(use(field.column).pureType);
  });

  /**
   * Field row id.
   */
  public get leaf() {
    return this.prop('leaf') as Observable<number>;
  }

  /**
   * A renderer of question instance.
   */
  public renderer = Computed.create(this, (use) => {
    const ctor = fieldConstructor(use(this.colType));
    const instance = new ctor(this);
    use.owner.autoDispose(instance);
    return instance;
  });

  constructor(box: FormLayoutNode, parent: BoxModel | null, view: FormView) {
    super(box, parent, view);

    this.required = Computed.create(this, (use) => {
      const field = use(this.field);
      return Boolean(use(field.widgetOptionsJson.prop('formRequired')));
    });

    this.question.onWrite(value => {
      this.field.peek().question.setAndSave(value).catch(reportError);
    });

    this.autoDispose(
      this.selected.addListener((now, then) => {
        if (!now && then) {
          setImmediate(() => !this.edit.isDisposed() && this.edit.set(false));
        }
      })
    );
  }

  public override render(...args: IDomArgs<HTMLElement>): HTMLElement {
    // Updated question is used for editing, we don't save on every key press, but only on blur (or enter, etc).
    const save = (value: string) => {
      value = value?.trim();
      // If question is empty or same as original, don't save.
      if (!value || value === this.field.peek().question()) {
        return;
      }
      this.field.peek().question.setAndSave(value).catch(reportError);
    };
    const overlay = Observable.create(null, true);

    const content = dom.domComputed(this.renderer, (r) => r.buildDom({
      edit: this.edit,
      overlay,
      onSave: save,
    }));

    return buildEditor({
        box: this,
        overlay,
        removeIcon: 'CrossBig',
        removeTooltip: t('Hide'),
        editMode: this.edit,
        content,
      },
      dom.on('dblclick', () => this.selected.get() && this.edit.set(true)),
      ...args
    );
  }

  public async deleteSelf() {
    const rowId = this.field.peek().id.peek();
    const view = this.view;
    const root = this.root();
    this.removeSelf();
    // The order here matters for undo.
    await root.save(async () => {
      // Make sure to save first layout without this field, otherwise the undo won't work properly.
      await root.save();
      // We are disposed at this point, be still can access the view.
      if (rowId) {
        await view.viewSection.removeField(rowId);
      }
    });
  }
}

export abstract class Question extends Disposable {
  protected field = this.model.field;

  constructor(public model: FieldModel) {
    super();
  }

  public buildDom(props: {
    edit: Observable<boolean>,
    overlay: Observable<boolean>,
    onSave: (value: string) => void,
  }, ...args: IDomArgs<HTMLElement>) {
    return css.cssQuestion(
      testId('question'),
      testType(this.model.colType),
      this.renderLabel(props),
      this.renderInput(),
      css.cssQuestion.cls('-required', this.model.required),
      ...args
    );
  }

  public abstract renderInput(): DomContents;

  protected renderLabel(props: {
    edit: Observable<boolean>,
    onSave: (value: string) => void,
  }, ...args: DomElementArg[]) {
    const {edit, onSave} = props;

    const scope = new MultiHolder();

    // When in edit, we will update a copy of the question.
    const draft = Observable.create(scope, this.model.question.get());
    scope.autoDispose(
      this.model.question.addListener(q => draft.set(q)),
    );
    const controller = Computed.create(scope, (use) => use(draft));
    controller.onWrite(value => {
      if (this.isDisposed() || draft.isDisposed()) { return; }
      if (!edit.get()) { return; }
      draft.set(value);
    });

    // Wire up save method.
    const saveDraft = (ok: boolean) => {
      if (this.isDisposed() || draft.isDisposed()) { return; }
      if (!ok || !edit.get() || !controller.get()) {
        controller.set(this.model.question.get());
        return;
      }
      onSave(controller.get());
    };
    let element: HTMLTextAreaElement;

    scope.autoDispose(
      props.edit.addListener((now, then) => {
        if (now && !then) {
          // When we go into edit mode, we copy the question into draft.
          draft.set(this.model.question.get());
          // And focus on the element.
          setTimeout(() => {
            element?.focus();
            element?.select();
          }, 10);
        }
      })
    );

    return [
      dom.autoDispose(scope),
      css.cssRequiredWrapper(
        testId('label'),
        // When in edit - hide * and change display from grid to display
        css.cssRequiredWrapper.cls('-required', use => use(this.model.required) && !use(this.model.edit)),
        dom.maybe(props.edit, () => [
          element = css.cssEditableLabel(
            controller,
            {onInput: true},
            // Attach common Enter,Escape, blur handlers.
            css.saveControls(edit, saveDraft),
            // Autoselect whole text when mounted.
            // Auto grow for textarea.
            autoGrow(controller),
            // Enable normal menu.
            dom.on('contextmenu', stopEvent),
            dom.style('resize', 'none'),
            css.cssEditableLabel.cls('-edit'),
            testId('label-editor'),
          ),
        ]),
        dom.maybe(not(props.edit), () => [
          css.cssRenderedLabel(
            dom.text(controller),
            testId('label-rendered'),
          ),
        ]),
        // When selected, we want to be able to edit the label by clicking it
        // so we need to make it relative and z-indexed.
        dom.style('position', u => u(this.model.selected) ? 'relative' : 'static'),
        dom.style('z-index', '2'),
        dom.on('click', (ev) => {
          if (this.model.selected.get() && !props.edit.get()) {
            props.edit.set(true);
            ev.stopPropagation();
          }
        }),
        ...args,
      ),
    ];
  }
}


class TextModel extends Question {
  private _format = Computed.create<FormTextFormat>(this, (use) => {
    const field = use(this.field);
    return use(field.widgetOptionsJson.prop('formTextFormat')) ?? 'singleline';
  });

  private _rowCount = Computed.create<number>(this, (use) => {
    const field = use(this.field);
    return use(field.widgetOptionsJson.prop('formTextLineCount')) || 3;
  });

  public renderInput() {
    return dom.domComputed(this._format, (format) => {
      switch (format) {
        case 'singleline': {
          return this._renderSingleLineInput();
        }
        case 'multiline': {
          return this._renderMultiLineInput();
        }
      }
    });
  }

  private _renderSingleLineInput() {
    return css.cssInput(
      dom.prop('name', u => u(u(this.field).colId)),
      {type: 'text', tabIndex: "-1"},
    );
  }

  private _renderMultiLineInput() {
    return css.cssTextArea(
      dom.prop('name', u => u(u(this.field).colId)),
      dom.prop('rows', this._rowCount),
      {tabIndex: "-1"},
    );
  }
}

class NumericModel extends Question {
  private _format = Computed.create<FormNumberFormat>(this, (use) => {
    const field = use(this.field);
    return use(field.widgetOptionsJson.prop('formNumberFormat')) ?? 'text';
  });

  public renderInput() {
    return dom.domComputed(this._format, (format) => {
      switch (format) {
        case 'text': {
          return this._renderTextInput();
        }
        case 'spinner': {
          return this._renderSpinnerInput();
        }
      }
    });
  }

  private _renderTextInput() {
    return css.cssInput(
      dom.prop('name', u => u(u(this.field).colId)),
      {type: 'text', tabIndex: "-1"},
    );
  }

  private _renderSpinnerInput() {
    return css.cssSpinner(observable(''), {});
  }
}

class ChoiceModel extends Question {
  protected choices: Computed<string[]>;

  protected alignment = Computed.create<FormOptionsAlignment>(this, (use) => {
    const field = use(this.field);
    return use(field.widgetOptionsJson.prop('formOptionsAlignment')) ?? 'vertical';
  });

  private _format = Computed.create<FormSelectFormat>(this, (use) => {
    const field = use(this.field);
    return use(field.widgetOptionsJson.prop('formSelectFormat')) ?? 'select';
  });

  private _sortOrder = Computed.create<FormOptionsSortOrder>(this, (use) => {
    const field = use(this.field);
    return use(field.widgetOptionsJson.prop('formOptionsSortOrder')) ?? 'default';
  });

  constructor(model: FieldModel) {
    super(model);
    this.choices = Computed.create(this, use => {
      // Read choices from field.
      const field = use(this.field);
      const choices = use(field.widgetOptionsJson.prop('choices'))?.slice() ?? [];

      // Make sure it is an array of strings.
      if (!Array.isArray(choices) || choices.some((choice) => typeof choice !== 'string')) {
        return [];
      } else {
        const sort = use(this._sortOrder);
        if (sort !== 'default') {
          choices.sort((a, b) => a.localeCompare(b));
          if (sort === 'descending') {
            choices.reverse();
          }
        }
        return choices;
      }
    });
  }

  public renderInput() {
    return dom('div',
      dom.domComputed(this._format, (format) => {
        if (format === 'select') {
          return this._renderSelectInput();
        } else {
          return this._renderRadioInput();
        }
      }),
      dom.maybe(use => use(this.choices).length === 0, () => [
        css.cssWarningMessage(css.cssWarningIcon('Warning'), t('No choices configured')),
      ]),
    );
  }

  private _renderSelectInput() {
    return css.cssSelect(
      {tabIndex: "-1"},
      ignoreClick,
      dom.prop('name', use => use(use(this.field).colId)),
      dom('option',
        selectPlaceholder(),
        {value: ''},
      ),
      dom.forEach(this.choices, (choice) => dom('option',
        choice,
        {value: choice},
      )),
    );
  }

  private _renderRadioInput() {
    return css.cssRadioList(
      css.cssRadioList.cls('-horizontal', use => use(this.alignment) === 'horizontal'),
      dom.prop('name', use => use(use(this.field).colId)),
      dom.forEach(this.choices, (choice) => css.cssRadioLabel(
        cssRadioInput({type: 'radio'}),
        choice,
      )),
    );
  }
}

class ChoiceListModel extends ChoiceModel {
  private _choices = Computed.create(this, use => {
    // Support for 30 choices. TODO: make limit dynamic.
    return use(this.choices).slice(0, 30);
  });

  public renderInput() {
    const field = this.field;
    return css.cssCheckboxList(
      css.cssCheckboxList.cls('-horizontal', use => use(this.alignment) === 'horizontal'),
      dom.prop('name', use => use(use(field).colId)),
      dom.forEach(this._choices, (choice) => css.cssCheckboxLabel(
        css.cssCheckboxLabel.cls('-horizontal', use => use(this.alignment) === 'horizontal'),
        cssCheckboxSquare({type: 'checkbox'}),
        choice,
      )),
      dom.maybe(use => use(this._choices).length === 0, () => [
        css.cssWarningMessage(css.cssWarningIcon('Warning'), t('No choices configured')),
      ]),
    );
  }
}

class BoolModel extends Question {
  private _format = Computed.create<FormToggleFormat>(this, (use) => {
    const field = use(this.field);
    return use(field.widgetOptionsJson.prop('formToggleFormat')) ?? 'switch';
  });

  public override buildDom(props: {
    edit: Observable<boolean>,
    overlay: Observable<boolean>,
    question: Observable<string>,
    onSave: () => void,
  }) {
    return css.cssQuestion(
      testId('question'),
      testType(this.model.colType),
      css.cssToggle(
        this.renderInput(),
        this.renderLabel(props, css.cssLabelInline.cls('')),
      ),
    );
  }

  public override renderInput() {
    return dom.domComputed(this._format, (format) => {
      if (format === 'switch') {
        return this._renderSwitchInput();
      } else {
        return this._renderCheckboxInput();
      }
    });
  }

  private _renderSwitchInput() {
    return css.cssWidgetSwitch(
      dom.style('--grist-actual-cell-color', colors.lightGreen.toString()),
      dom.cls('switch_transition'),
      dom('div.switch_slider'),
      dom('div.switch_circle'),
    );
  }

  private _renderCheckboxInput() {
    return cssLabel(
      cssCheckboxSquare({type: 'checkbox'}),
    );
  }
}

class DateModel extends Question {
  public renderInput() {
    return dom('div',
      css.cssInput(
        dom.prop('name', this.model.colId),
        {type: 'date', style: 'margin-right: 5px;'},
      ),
    );
  }
}

class DateTimeModel extends Question {
  public renderInput() {
    return dom('div',
      css.cssInput(
        dom.prop('name', this.model.colId),
        {type: 'datetime-local', style: 'margin-right: 5px;'},
      ),
      dom.style('width', '100%'),
    );
  }
}

class RefListModel extends Question {
  protected options: Computed<{label: string, value: string}[]>;

  protected alignment = Computed.create<FormOptionsAlignment>(this, (use) => {
    const field = use(this.field);
    return use(field.widgetOptionsJson.prop('formOptionsAlignment')) ?? 'vertical';
  });

  private _sortOrder = Computed.create<FormOptionsSortOrder>(this, (use) => {
    const field = use(this.field);
    return use(field.widgetOptionsJson.prop('formOptionsSortOrder')) ?? 'default';
  });

  constructor(model: FieldModel) {
    super(model);
    this.options = this._getOptions();
  }

  public renderInput() {
    return css.cssCheckboxList(
      css.cssCheckboxList.cls('-horizontal', use => use(this.alignment) === 'horizontal'),
      dom.prop('name', this.model.colId),
      dom.forEach(this.options, (option) => css.cssCheckboxLabel(
        squareCheckbox(observable(false)),
        option.label,
      )),
      dom.maybe(use => use(this.options).length === 0, () => [
        css.cssWarningMessage(
          css.cssWarningIcon('Warning'),
          t('No values in show column of referenced table'),
        ),
      ]),
    );
  }

  private _getOptions() {
    const tableId = Computed.create(this, use => {
      const refTable = use(use(this.model.column).refTable);
      return refTable ? use(refTable.tableId) : '';
    });

    const colId = Computed.create(this, use => {
      const dispColumnIdObs = use(use(this.model.column).visibleColModel);
      return use(dispColumnIdObs.colId) || 'id';
    });

    const observer = this._columnObserver(this, this.model.view.gristDoc.docModel, tableId, colId);

    return Computed.create(this, use => {
      const sort = use(this._sortOrder);
      const values = use(observer)
        .filter(([_id, value]) => !isBlankValue(value))
        .map(([id, value]) => ({label: String(value), value: String(id)}));
      if (sort !== 'default') {
        values.sort((a, b) => a.label.localeCompare(b.label));
        if (sort === 'descending') {
          values.reverse();
        }
      }
      return values.slice(0, 30);
    });
  }


  /**
   * Creates computed with all the data for the given column.
   */
  private _columnObserver(
    owner: IDisposableOwner,
    docModel: DocModel,
    tableId: Observable<string>,
    columnId: Observable<string>
  ) {
    const tableModel = Computed.create(owner, (use) => docModel.dataTables[use(tableId)]);
    const refreshed = Observable.create(owner, 0);
    const toggle = () => !refreshed.isDisposed() && refreshed.set(refreshed.get() + 1);
    const holder = Holder.create(owner);
    const listener = (tab: TableModel) => {
      if (tab.tableData.tableId === '') { return; }

      // Now subscribe to any data change in that table.
      const subs = MultiHolder.create(holder);
      subs.autoDispose(tab.tableData.dataLoadedEmitter.addListener(toggle));
      subs.autoDispose(tab.tableData.tableActionEmitter.addListener(toggle));
      tab.fetch().catch(reportError);
    };
    owner.autoDispose(tableModel.addListener(listener));
    listener(tableModel.get());
    const values = Computed.create(owner, refreshed, (use) => {
      const rows = use(tableModel).getAllRows();
      const colValues = use(tableModel).tableData.getColValues(use(columnId));
      if (!colValues) { return []; }
      return rows.map((row, i) => [row, colValues[i]]);
    });
    return values;
  }
}

class RefModel extends RefListModel {
  private _format = Computed.create<FormSelectFormat>(this, (use) => {
    const field = use(this.field);
    return use(field.widgetOptionsJson.prop('formSelectFormat')) ?? 'select';
  });

  public renderInput() {
    return dom('div',
      dom.domComputed(this._format, (format) => {
        if (format === 'select') {
          return this._renderSelectInput();
        } else {
          return this._renderRadioInput();
        }
      }),
      dom.maybe(use => use(this.options).length === 0, () => [
        css.cssWarningMessage(
          css.cssWarningIcon('Warning'),
          t('No values in show column of referenced table'),
        ),
      ]),
    );
  }

  private _renderSelectInput() {
    return css.cssSelect(
      {tabIndex: "-1"},
      ignoreClick,
      dom.prop('name', this.model.colId),
      dom('option',
        selectPlaceholder(),
        {value: ''},
      ),
      dom.forEach(this.options, ({label, value}) => dom('option',
        label,
        {value},
      )),
    );
  }

  private _renderRadioInput() {
    return css.cssRadioList(
      css.cssRadioList.cls('-horizontal', use => use(this.alignment) === 'horizontal'),
      dom.prop('name', use => use(use(this.field).colId)),
      dom.forEach(this.options, ({label, value}) => css.cssRadioLabel(
        cssRadioInput({type: 'radio'}),
        label,
      )),
    );
  }
}

const AnyModel = TextModel;

class AttachmentsModel extends Question {
  public renderInput() {
    return dom('div',
      css.cssAttachmentInput(
        dom.prop('name', use => use(use(this.field).colId)),
        dom.prop('type', 'file'),
        dom.prop('multiple', true),
      ),
    );
  }
}

function fieldConstructor(type: string): Constructor<Question> {
  switch (type) {
    case 'Any': return AnyModel;
    case 'Bool': return BoolModel;
    case 'Choice': return ChoiceModel;
    case 'ChoiceList': return ChoiceListModel;
    case 'Date': return DateModel;
    case 'DateTime': return DateTimeModel;
    case 'Int': return NumericModel;
    case 'Numeric': return NumericModel;
    case 'Ref': return RefModel;
    case 'RefList': return RefListModel;
    case 'Attachments': return AttachmentsModel;
    default: return TextModel;
  }
}

/**
 * Creates a hidden input element with element type. Used in tests.
 */
function testType(value: BindableValue<string>) {
  return dom('input', {type: 'hidden'}, dom.prop('value', value), testId('type'));
}
